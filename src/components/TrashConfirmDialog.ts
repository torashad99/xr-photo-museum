// src/components/TrashConfirmDialog.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { getControllerTips } from './InputHelpers';

export interface TrashConfirmHandle {
  checkPress(world: World): 'yes' | 'no' | null;
  checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): 'yes' | 'no' | null;
  dispose(): void;
}

export function createTrashConfirmDialog(
  world: World,
  framePosition: THREE.Vector3,
  frameRotation: THREE.Euler,
): TrashConfirmHandle {
  const group = new THREE.Group();
  group.position.copy(framePosition);
  group.rotation.copy(frameRotation);
  world.scene.add(group);

  // ── Title label ──
  const titleCanvas = document.createElement('canvas');
  titleCanvas.width = 512;
  titleCanvas.height = 96;
  const titleCtx = titleCanvas.getContext('2d')!;
  titleCtx.fillStyle = 'rgba(0,0,0,0.8)';
  titleCtx.fillRect(0, 0, 512, 96);
  titleCtx.fillStyle = '#ffffff';
  titleCtx.font = 'bold 36px Arial';
  titleCtx.textAlign = 'center';
  titleCtx.textBaseline = 'middle';
  titleCtx.fillText('Delete this world?', 256, 48);
  const titleTex = new THREE.CanvasTexture(titleCanvas);
  const titleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.19),
    new THREE.MeshBasicMaterial({ map: titleTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  titleMesh.position.set(0, 0, 1.75);
  group.add(titleMesh);

  // ── Button factory ──
  function makeBtn(label: string, bgHex: number, w: number, h: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.04),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    mesh.userData.tex = tex;
    mesh.userData.canvas = c;
    mesh.userData.ctx = ctx;
    mesh.userData.bgHex = bgHex;
    redrawBtn(mesh, false, label);
    return mesh;
  }

  function redrawBtn(mesh: THREE.Mesh, hovered: boolean, label: string) {
    const ctx = mesh.userData.ctx as CanvasRenderingContext2D;
    const base = mesh.userData.bgHex as number;
    const r = Math.min(255, ((base >> 16) & 0xff) + (hovered ? 40 : 0));
    const g = Math.min(255, ((base >> 8) & 0xff) + (hovered ? 40 : 0));
    const b = Math.min(255, (base & 0xff) + (hovered ? 40 : 0));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, 256, 96);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(3, 3, 250, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 128, 48);
    (mesh.userData.tex as THREE.CanvasTexture).needsUpdate = true;
  }

  const yesBtn = makeBtn('YES — Delete', 0x992222, 0.5, 0.22);
  yesBtn.position.set(-0.32, 0, 1.75 + 0.01);
  group.add(yesBtn);

  const noBtn = makeBtn('NO — Keep', 0x226622, 0.5, 0.22);
  noBtn.position.set(0.32, 0, 1.75 + 0.01);
  group.add(noBtn);

  // Shift title above buttons
  titleMesh.position.y = 0.27;
  yesBtn.position.y = 0;
  noBtn.position.y = 0;

  // ── Press detection ──
  const _box = new THREE.Box3();

  type BtnState = { mesh: THREE.Mesh; hovered: boolean; pressedLast: boolean; label: string };
  const btns: BtnState[] = [
    { mesh: yesBtn, hovered: false, pressedLast: false, label: 'YES — Delete' },
    { mesh: noBtn, hovered: false, pressedLast: false, label: 'NO — Keep' },
  ];

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

  function checkPress(world: World): 'yes' | 'no' | null {
    const tips = getControllerTips(world);
    for (let i = 0; i < btns.length; i++) {
      const s = btns[i];
      const r = checkBoxPress(s.mesh, tips, s.pressedLast);
      s.pressedLast = r.nextLast;
      if (r.hit !== s.hovered) {
        s.hovered = r.hit;
        redrawBtn(s.mesh, r.hit, s.label);
      }
      if (r.pressed) return i === 0 ? 'yes' : 'no';
    }
    return null;
  }

  function checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): 'yes' | 'no' | null {
    for (let i = 0; i < btns.length; i++) {
      const s = btns[i];
      const hit = raycaster.intersectObject(s.mesh).length > 0;
      if (hit !== s.hovered) {
        s.hovered = hit;
        redrawBtn(s.mesh, hit, s.label);
      }
      if (hit && interactDown && !s.pressedLast) {
        s.pressedLast = true;
        return i === 0 ? 'yes' : 'no';
      }
      if (!hit || !interactDown) s.pressedLast = false;
    }
    return null;
  }

  function dispose() {
    world.scene.remove(group);
    titleTex.dispose();
    (titleMesh.material as THREE.MeshBasicMaterial).dispose();
    titleMesh.geometry.dispose();
    for (const s of btns) {
      (s.mesh.userData.tex as THREE.CanvasTexture).dispose();
      (s.mesh.material as THREE.MeshBasicMaterial).dispose();
      s.mesh.geometry.dispose();
    }
  }

  return { checkPress, checkRaycastPress, dispose };
}
