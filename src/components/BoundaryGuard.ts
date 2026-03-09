// src/components/BoundaryGuard.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';

export interface BoundaryGuardHandle {
  update(world: World): void;
  checkReturn(world: World): boolean;
  dispose(): void;
}

export function createBoundaryGuard(
  world: World,
  origin: THREE.Vector3,
  radius: number = 5,
): BoundaryGuardHandle {
  // "Go Back to Gallery" button
  const buttonGroup = new THREE.Group();
  buttonGroup.visible = false;

  const buttonCanvas = document.createElement('canvas');
  const buttonCtx = buttonCanvas.getContext('2d')!;
  buttonCanvas.width = 512;
  buttonCanvas.height = 128;

  const buttonTexture = new THREE.CanvasTexture(buttonCanvas);

  function drawButton(text: string, bgColor: string) {
    buttonCtx.fillStyle = bgColor;
    buttonCtx.fillRect(0, 0, buttonCanvas.width, buttonCanvas.height);
    buttonCtx.strokeStyle = '#ffffff';
    buttonCtx.lineWidth = 4;
    buttonCtx.strokeRect(4, 4, buttonCanvas.width - 8, buttonCanvas.height - 8);
    buttonCtx.fillStyle = '#ffffff';
    buttonCtx.font = 'bold 32px Arial';
    buttonCtx.textAlign = 'center';
    buttonCtx.textBaseline = 'middle';
    buttonCtx.fillText(text, buttonCanvas.width / 2, buttonCanvas.height / 2);
    buttonTexture.needsUpdate = true;
  }

  drawButton('Go Back to Gallery', '#8a1a1a');

  const buttonGeometry = new THREE.BoxGeometry(1.2, 0.35, 0.05);
  const buttonMaterial = new THREE.MeshBasicMaterial({ map: buttonTexture, side: THREE.DoubleSide });
  const buttonMesh = new THREE.Mesh(buttonGeometry, buttonMaterial);
  buttonGroup.add(buttonMesh);

  world.scene.add(buttonGroup);

  let isVisible = false;
  let isHovered = false;
  let pressedLastFrame = false;

  const _buttonBox = new THREE.Box3();
  const _camPos = new THREE.Vector3();

  function getControllerTips(world: World): THREE.Vector3[] {
    const tips: THREE.Vector3[] = [];
    const raySpaces = world.input.xrOrigin?.raySpaces;
    if (raySpaces) {
      if (raySpaces.left) tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.left.matrixWorld));
      if (raySpaces.right) tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.right.matrixWorld));
    }
    const hands = world.input.visualAdapters?.hand;
    if (hands) {
      if (hands.left?.connected && hands.left.gripSpace)
        tips.push(new THREE.Vector3().setFromMatrixPosition(hands.left.gripSpace.matrixWorld));
      if (hands.right?.connected && hands.right.gripSpace)
        tips.push(new THREE.Vector3().setFromMatrixPosition(hands.right.gripSpace.matrixWorld));
    }
    return tips;
  }

  function update(world: World) {
    world.camera.getWorldPosition(_camPos);
    const dist = _camPos.distanceTo(origin);
    const ratio = dist / radius;

    if (ratio > 0.8 && !isVisible) {
      isVisible = true;
      buttonGroup.visible = true;
    } else if (ratio <= 0.75 && isVisible) {
      isVisible = false;
      buttonGroup.visible = false;
    }

    if (isVisible) {
      // Position the button in front of the camera, facing the user
      const camera = world.camera;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      buttonGroup.position.copy(_camPos).addScaledVector(forward, 1.5);
      buttonGroup.position.y = _camPos.y; // Keep at eye level
      buttonGroup.lookAt(_camPos);

      // Fade based on distance
      const fadeAlpha = Math.min(1, (ratio - 0.8) / 0.15);
      buttonMaterial.opacity = fadeAlpha;
      buttonMaterial.transparent = fadeAlpha < 1;
    }
  }

  function checkReturn(world: World): boolean {
    if (!isVisible) return false;

    buttonMesh.updateWorldMatrix(true, false);
    _buttonBox.setFromObject(buttonMesh);
    _buttonBox.expandByScalar(0.05);

    const tips = getControllerTips(world);
    let anyInside = false;

    for (const tip of tips) {
      if (_buttonBox.containsPoint(tip)) {
        anyInside = true;
        break;
      }
    }

    if (anyInside && !isHovered) {
      isHovered = true;
      drawButton('Go Back to Gallery', '#bb4444');
    } else if (!anyInside && isHovered) {
      isHovered = false;
      drawButton('Go Back to Gallery', '#8a1a1a');
    }

    if (anyInside && !pressedLastFrame) {
      pressedLastFrame = true;
      return true;
    }
    if (!anyInside) {
      pressedLastFrame = false;
    }

    return false;
  }

  function dispose() {
    world.scene.remove(buttonGroup);
    buttonGeometry.dispose();
    buttonMaterial.dispose();
    buttonTexture.dispose();
  }

  return { update, checkReturn, dispose };
}
