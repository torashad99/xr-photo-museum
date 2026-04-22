// src/components/SplatAdjustPanel.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { getControllerTips } from './InputHelpers';
import { GaussianSplatWorld } from './GaussianSplatWorld';

export interface SplatAdjustPanelHandle {
  update(camera: THREE.Camera): void;
  checkPress(world: World): void;
  checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): void;
  flashSaved(): void;
  dispose(): void;
}

const PANEL_W = 1.6;
const PANEL_H = 0.28;
const BTN_H = 0.22;
const BTN_GAP = 0.04;
const ANCHOR_DIST = 1.5;
const ANCHOR_Y = 1.3;

const PRESET_COUNT = 6;
const SCALE_STEP = 0.1;
const MIN_SCALE = 0.3;
const MAX_SCALE = 15.0;

export function createSplatAdjustPanel(
  world: World,
  camera: THREE.Camera,
  splatWorld: GaussianSplatWorld,
  onSave: (preset: number, scale: number) => void,
): SplatAdjustPanelHandle {
  const group = new THREE.Group();
  world.scene.add(group);

  // Set position once, 1.5m ahead of player at eye level
  {
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();
    group.position.set(
      camPos.x + camDir.x * ANCHOR_DIST,
      ANCHOR_Y,
      camPos.z + camDir.z * ANCHOR_DIST,
    );
    // Face the camera (panel's +Z toward camera = negate camDir)
    group.rotation.y = Math.atan2(-camDir.x, -camDir.z);
  }

  // ── Background ──
  const bgGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
  const bgMat = new THREE.MeshBasicMaterial({
    color: 0x111122,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bgMesh = new THREE.Mesh(bgGeo, bgMat);
  group.add(bgMesh);

  // ── Button factory ──
  function makeBtn(
    label: string,
    bgHex: string,
    w: number,
  ): { mesh: THREE.Mesh; tex: THREE.CanvasTexture; redraw: (hov: boolean, lbl?: string) => void } {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, BTN_H, 0.04),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );

    function redraw(hov: boolean, lbl: string = label) {
      const base = parseInt(bgHex.replace('#', ''), 16);
      const r = Math.min(255, ((base >> 16) & 0xff) + (hov ? 40 : 0));
      const g = Math.min(255, ((base >> 8) & 0xff) + (hov ? 40 : 0));
      const b = Math.min(255, (base & 0xff) + (hov ? 40 : 0));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 256, 96);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, 252, 92);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 19px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(lbl, 128, 48);
      tex.needsUpdate = true;
    }

    redraw(false);
    return { mesh, tex, redraw };
  }

  // Button widths: [Orientation 0.46][−0.16][scale 0.22][+0.16][Save 0.44] + 4 gaps
  const totalContent = 0.46 + 0.16 + 0.22 + 0.16 + 0.44 + 4 * BTN_GAP;
  const startX = -totalContent / 2 + 0.46 / 2;
  function nextX(prevX: number, prevW: number, nextW: number): number {
    return prevX + prevW / 2 + BTN_GAP + nextW / 2;
  }

  const orientBtn = makeBtn('Try orientation', '#2255aa', 0.46);
  orientBtn.mesh.position.set(startX, 0, 0.03);
  group.add(orientBtn.mesh);

  const decBtn = makeBtn('−', '#555555', 0.16);
  decBtn.mesh.position.set(nextX(startX, 0.46, 0.16), 0, 0.03);
  group.add(decBtn.mesh);

  const scaleBtn = makeBtn('1.5×', '#333344', 0.22);
  scaleBtn.mesh.position.set(nextX(decBtn.mesh.position.x, 0.16, 0.22), 0, 0.03);
  group.add(scaleBtn.mesh);

  const incBtn = makeBtn('+', '#555555', 0.16);
  incBtn.mesh.position.set(nextX(scaleBtn.mesh.position.x, 0.22, 0.16), 0, 0.03);
  group.add(incBtn.mesh);

  const saveBtn = makeBtn('Save fix', '#336633', 0.44);
  saveBtn.mesh.position.set(nextX(incBtn.mesh.position.x, 0.16, 0.44), 0, 0.03);
  group.add(saveBtn.mesh);

  // Track live state
  let currentPreset = splatWorld.getCurrentTransform().preset;
  let currentScale = splatWorld.getCurrentTransform().scale;

  function updateScaleLabel() {
    scaleBtn.redraw(scaleHovered, `${currentScale.toFixed(1)}×`);
  }

  // ── Hover/press state per button ──
  const _box = new THREE.Box3();

  type BtnState = {
    btn: ReturnType<typeof makeBtn>;
    hovered: boolean;
    pressedLast: boolean;
  };

  const buttons: BtnState[] = [
    { btn: orientBtn, hovered: false, pressedLast: false },
    { btn: decBtn, hovered: false, pressedLast: false },
    { btn: scaleBtn, hovered: false, pressedLast: false },
    { btn: incBtn, hovered: false, pressedLast: false },
    { btn: saveBtn, hovered: false, pressedLast: false },
  ];

  let scaleHovered = false; // alias for scaleBtn hover

  function onPress(idx: number) {
    switch (idx) {
      case 0: {
        // Cycle orientation preset
        currentPreset = (currentPreset + 1) % PRESET_COUNT;
        splatWorld.applyPreset(currentPreset, currentScale);
        break;
      }
      case 1: {
        // Decrease scale
        currentScale = Math.max(MIN_SCALE, parseFloat((currentScale - SCALE_STEP).toFixed(2)));
        splatWorld.applyPreset(currentPreset, currentScale);
        updateScaleLabel();
        break;
      }
      case 2:
        // Scale display — no action
        break;
      case 3: {
        // Increase scale
        currentScale = Math.min(MAX_SCALE, parseFloat((currentScale + SCALE_STEP).toFixed(2)));
        splatWorld.applyPreset(currentPreset, currentScale);
        updateScaleLabel();
        break;
      }
      case 4: {
        // Save fix
        onSave(currentPreset, currentScale);
        flashSaved();
        break;
      }
    }
  }

  function checkBoxPress(
    mesh: THREE.Mesh,
    tips: THREE.Vector3[],
    pressedLast: boolean,
  ): { hit: boolean; pressed: boolean; nextLast: boolean } {
    mesh.updateWorldMatrix(true, false);
    _box.setFromObject(mesh).expandByScalar(0.04);
    const anyInside = tips.some(t => _box.containsPoint(t));
    if (anyInside && !pressedLast) return { hit: true, pressed: true, nextLast: true };
    return { hit: anyInside, pressed: false, nextLast: anyInside };
  }

  function checkPress(world: World): void {
    const tips = getControllerTips(world);
    for (let i = 0; i < buttons.length; i++) {
      const s = buttons[i];
      const r = checkBoxPress(s.btn.mesh, tips, s.pressedLast);
      s.pressedLast = r.nextLast;
      if (r.hit !== s.hovered) {
        s.hovered = r.hit;
        if (i === 2) scaleHovered = r.hit;
        i === 2 ? updateScaleLabel() : s.btn.redraw(r.hit);
      }
      if (r.pressed) onPress(i);
    }
  }

  function checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): void {
    for (let i = 0; i < buttons.length; i++) {
      const s = buttons[i];
      const hit = raycaster.intersectObject(s.btn.mesh).length > 0;
      if (hit !== s.hovered) {
        s.hovered = hit;
        if (i === 2) scaleHovered = hit;
        i === 2 ? updateScaleLabel() : s.btn.redraw(hit);
      }
      if (hit && interactDown && !s.pressedLast) {
        s.pressedLast = true;
        onPress(i);
      }
      if (!hit || !interactDown) s.pressedLast = false;
    }
  }

  let flashTimer = 0;
  function flashSaved() {
    saveBtn.redraw(false, 'Saved!');
    flashTimer = 1.2;
  }

  const _camDir = new THREE.Vector3();

  function update(camera: THREE.Camera): void {
    // Position is fixed; only billboard (rotate to face camera each frame)
    camera.getWorldDirection(_camDir);
    _camDir.y = 0;
    _camDir.normalize();
    group.rotation.y = Math.atan2(-_camDir.x, -_camDir.z);

    // Flash countdown
    if (flashTimer > 0) {
      flashTimer -= 0.016;
      if (flashTimer <= 0) {
        saveBtn.redraw(buttons[4].hovered, 'Save fix');
      }
    }
  }

  function dispose() {
    world.scene.remove(group);
    bgGeo.dispose();
    bgMat.dispose();
    for (const s of buttons) {
      s.btn.mesh.geometry.dispose();
      (s.btn.mesh.material as THREE.MeshBasicMaterial).dispose();
      s.btn.tex.dispose();
    }
  }

  return { update, checkPress, checkRaycastPress, flashSaved, dispose };
}
