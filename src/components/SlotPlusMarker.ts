// src/components/SlotPlusMarker.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { getControllerTips } from './InputHelpers';

export interface SlotPlusMarkerHandle {
  mesh: THREE.Mesh;
  checkPress(world: World): boolean;
  checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): boolean;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createSlotPlusMarker(frameGroup: THREE.Group): SlotPlusMarkerHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  function draw(hovered: boolean) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = hovered ? 'rgba(0, 0, 0, 0.65)' : 'rgba(0, 0, 0, 0.45)';
    // Rounded rect background
    const r = 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(256 - r, 0);
    ctx.quadraticCurveTo(256, 0, 256, r);
    ctx.lineTo(256, 256 - r);
    ctx.quadraticCurveTo(256, 256, 256 - r, 256);
    ctx.lineTo(r, 256);
    ctx.quadraticCurveTo(0, 256, 0, 256 - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    // "+" cross
    const color = hovered ? '#aaffcc' : '#ffffff';
    ctx.fillStyle = color;
    const thick = 28;
    const margin = 64;
    // Horizontal bar
    ctx.fillRect(margin, 128 - thick / 2, 256 - margin * 2, thick);
    // Vertical bar
    ctx.fillRect(128 - thick / 2, margin, thick, 256 - margin * 2);
    texture.needsUpdate = true;
  }

  const texture = new THREE.CanvasTexture(canvas);
  const geometry = new THREE.PlaneGeometry(0.6, 0.6);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // Sit just in front of the photo canvas (which is at z=0.06)
  mesh.position.z = 0.08;
  frameGroup.add(mesh);

  draw(false);

  let isHovered = false;
  let pressedLastFrame = false;
  const _box = new THREE.Box3();

  function checkPress(world: World): boolean {
    if (!mesh.visible) return false;

    mesh.updateWorldMatrix(true, false);
    _box.setFromObject(mesh);
    _box.expandByScalar(0.05);

    const tips = getControllerTips(world);
    let anyInside = false;
    for (const tip of tips) {
      if (_box.containsPoint(tip)) { anyInside = true; break; }
    }

    if (anyInside && !isHovered) { isHovered = true; draw(true); }
    else if (!anyInside && isHovered) { isHovered = false; draw(false); }

    if (anyInside && !pressedLastFrame) {
      pressedLastFrame = true;
      return true;
    }
    if (!anyInside) pressedLastFrame = false;
    return false;
  }

  function checkRaycastPress(raycaster: THREE.Raycaster, interactDown: boolean): boolean {
    if (!mesh.visible) return false;

    const hits = raycaster.intersectObject(mesh);
    const isHit = hits.length > 0;

    if (isHit && !isHovered) { isHovered = true; draw(true); }
    else if (!isHit && isHovered) { isHovered = false; draw(false); }

    if (isHit && interactDown && !pressedLastFrame) {
      pressedLastFrame = true;
      return true;
    }
    if (!isHit || !interactDown) pressedLastFrame = false;
    return false;
  }

  function setVisible(visible: boolean) {
    mesh.visible = visible;
    if (!visible) {
      isHovered = false;
      pressedLastFrame = false;
    }
  }

  function dispose() {
    frameGroup.remove(mesh);
    geometry.dispose();
    material.dispose();
    texture.dispose();
  }

  return { mesh, checkPress, checkRaycastPress, setVisible, dispose };
}
