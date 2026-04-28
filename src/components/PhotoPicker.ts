// src/components/PhotoPicker.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { getControllerTips } from './InputHelpers';
import { pickLocalPhoto } from '../services/LocalPhotoPicker';

const PANEL_Z_OFFSET = 1.6;
const PANEL_W = 2.0;
const PANEL_H = 0.8;

export interface PhotoPickerHandle {
  checkPress(world: World): void;
  checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): void;
  dispose(): void;
}

export interface PhotoPickerCallbacks {
  onSelect(photoUrl: string, photoId: string, photoName: string): void;
  onCancel(): void;
}

export function createPhotoPicker(
  world: World,
  framePosition: THREE.Vector3,
  frameRotation: THREE.Euler,
  callbacks: PhotoPickerCallbacks,
): PhotoPickerHandle {
  const group = new THREE.Group();
  group.position.copy(framePosition);
  group.rotation.copy(frameRotation);
  world.scene.add(group);

  // ── Background panel ──
  const bgGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
  const bgMat = new THREE.MeshBasicMaterial({
    color: 0x111111,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bgMesh = new THREE.Mesh(bgGeo, bgMat);
  bgMesh.position.set(0, 0, PANEL_Z_OFFSET);
  group.add(bgMesh);

  // ── Title label ──
  function makeTextPlane(
    text: string,
    w: number,
    h: number,
    fontSize: number,
    color = '#ffffff',
    bg = 'transparent',
  ): THREE.Mesh {
    const c = document.createElement('canvas');
    const pw = 512;
    const ph = Math.round((h / w) * pw);
    c.width = pw;
    c.height = ph;
    const ctx = c.getContext('2d')!;
    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, pw, ph);
    }
    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pw / 2, ph / 2);
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    return mesh;
  }

  const titleMesh = makeTextPlane('Pick a photo for this slot', 1.8, 0.16, 34);
  titleMesh.position.set(0, 0.25, PANEL_Z_OFFSET + 0.01);
  group.add(titleMesh);

  // ── Action buttons ──
  function makeButtonMesh(label: string, bgColor: string, w = 0.65, h = 0.22): {
    mesh: THREE.Mesh;
    texture: THREE.CanvasTexture;
    draw: (hovered: boolean) => void;
  } {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.04),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );

    function draw(hovered: boolean) {
      ctx.fillStyle = hovered ? lighten(bgColor) : bgColor;
      ctx.fillRect(0, 0, 256, 96);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeRect(3, 3, 250, 90);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 128, 48);
      tex.needsUpdate = true;
    }

    draw(false);
    return { mesh, texture: tex, draw };
  }

  function lighten(hex: string): string {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, ((n >> 16) & 0xff) + 40);
    const g = Math.min(255, ((n >> 8) & 0xff) + 40);
    const b = Math.min(255, (n & 0xff) + 40);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  const localBtn = makeButtonMesh('Local photos', '#555555', 0.75, 0.26);
  localBtn.mesh.position.set(-0.4, 0, PANEL_Z_OFFSET + 0.02);
  group.add(localBtn.mesh);

  const cancelBtn = makeButtonMesh('Cancel', '#7a2222', 0.55, 0.26);
  cancelBtn.mesh.position.set(0.4, 0, PANEL_Z_OFFSET + 0.02);
  group.add(cancelBtn.mesh);

  let disposed = false;

  // ── Press detection helpers ──
  const _box = new THREE.Box3();
  let localPressedLast = false;
  let cancelPressedLast = false;
  let localHovered = false;
  let cancelHovered = false;

  function checkBoxPress(mesh: THREE.Mesh, tips: THREE.Vector3[], pressedLast: boolean): { hit: boolean; pressed: boolean; nextLast: boolean } {
    mesh.updateWorldMatrix(true, false);
    _box.setFromObject(mesh);
    _box.expandByScalar(0.04);
    let anyInside = false;
    for (const t of tips) { if (_box.containsPoint(t)) { anyInside = true; break; } }
    if (anyInside && !pressedLast) return { hit: true, pressed: true, nextLast: true };
    return { hit: anyInside, pressed: false, nextLast: anyInside };
  }

  function checkPress(world: World): void {
    const tips = getControllerTips(world);

    const lResult = checkBoxPress(localBtn.mesh, tips, localPressedLast);
    localPressedLast = lResult.nextLast;
    if (lResult.hit !== localHovered) { localHovered = lResult.hit; localBtn.draw(localHovered); }
    if (lResult.pressed) handleLocalPhoto();

    const cResult = checkBoxPress(cancelBtn.mesh, tips, cancelPressedLast);
    cancelPressedLast = cResult.nextLast;
    if (cResult.hit !== cancelHovered) { cancelHovered = cResult.hit; cancelBtn.draw(cancelHovered); }
    if (cResult.pressed) callbacks.onCancel();
  }

  function checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): void {
    const lHit = raycaster.intersectObject(localBtn.mesh).length > 0;
    if (lHit !== localHovered) { localHovered = lHit; localBtn.draw(localHovered); }
    if (lHit && interactDown && !localPressedLast) {
      localPressedLast = true;
      handleLocalPhoto();
    }
    if (!lHit || !interactDown) localPressedLast = false;

    const cHit = raycaster.intersectObject(cancelBtn.mesh).length > 0;
    if (cHit !== cancelHovered) { cancelHovered = cHit; cancelBtn.draw(cancelHovered); }
    if (cHit && interactDown && !cancelPressedLast) {
      cancelPressedLast = true;
      callbacks.onCancel();
    }
    if (!cHit || !interactDown) cancelPressedLast = false;
  }

  async function handleLocalPhoto() {
    const result = await pickLocalPhoto();
    if (!result) return;
    callbacks.onSelect(result.photoUrl, result.photoId, result.photoName);
  }

  function dispose() {
    disposed = true;
    world.scene.remove(group);
    bgGeo.dispose();
    bgMat.dispose();
    [localBtn, cancelBtn].forEach(({ mesh, texture }) => {
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshBasicMaterial).dispose();
      texture.dispose();
    });
    (titleMesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (titleMesh.material as THREE.MeshBasicMaterial).dispose();
    titleMesh.geometry.dispose();
  }

  return { checkPress, checkRaycastPress, dispose };
}
