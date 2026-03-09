// src/components/PortalUI.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';

export type PortalButtonState = 'generate' | 'waiting' | 'enter';

export interface PortalUIHandle {
  checkPress(world: World): PortalButtonState | null;
  setState(state: PortalButtonState): void;
  startCountdown(durationMs: number): void;
  updateCountdown(): void;
  getState(): PortalButtonState;
  dispose(): void;
}

export function createPortalUI(
  world: World,
  framePosition: THREE.Vector3,
  frameRotation: THREE.Euler,
  imageName: string,
  initialState: PortalButtonState = 'generate',
): PortalUIHandle {
  const uiGroup = new THREE.Group();

  // Position below the frame
  uiGroup.position.copy(framePosition);
  uiGroup.position.y -= 1.2;
  uiGroup.rotation.copy(frameRotation);

  // Name label
  const nameCanvas = document.createElement('canvas');
  const nameCtx = nameCanvas.getContext('2d')!;
  nameCanvas.width = 512;
  nameCanvas.height = 64;
  nameCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  nameCtx.fillRect(0, 0, nameCanvas.width, nameCanvas.height);
  nameCtx.fillStyle = '#ffffff';
  nameCtx.font = 'bold 28px Arial';
  nameCtx.textAlign = 'center';
  nameCtx.fillText(imageName, nameCanvas.width / 2, 44);

  const nameTexture = new THREE.CanvasTexture(nameCanvas);
  const nameMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.12),
    new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  nameMesh.position.y = 0.25;
  nameMesh.position.z = 0.06;
  uiGroup.add(nameMesh);

  // Button
  const buttonGeometry = new THREE.BoxGeometry(1.0, 0.3, 0.05);
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
    buttonCtx.font = 'bold 36px Arial';
    buttonCtx.textAlign = 'center';
    buttonCtx.textBaseline = 'middle';
    buttonCtx.fillText(text, buttonCanvas.width / 2, buttonCanvas.height / 2);
    buttonTexture.needsUpdate = true;
  }

  const buttonMaterial = new THREE.MeshBasicMaterial({ map: buttonTexture, side: THREE.DoubleSide });
  const buttonMesh = new THREE.Mesh(buttonGeometry, buttonMaterial);
  buttonMesh.position.z = 0.06;
  uiGroup.add(buttonMesh);

  world.scene.add(uiGroup);

  let state: PortalButtonState = initialState;
  let isHovered = false;
  let pressedLastFrame = false;

  // Countdown state
  let countdownEndTime = 0;

  // Colors per state
  const STATE_COLORS: Record<PortalButtonState, { normal: string; hover: string; press: string }> = {
    generate: { normal: '#1a6a4a', hover: '#2a8a6a', press: '#3aaa8a' },
    waiting:  { normal: '#555555', hover: '#555555', press: '#555555' },
    enter:    { normal: '#4a1a8a', hover: '#7a3aba', press: '#aa66ee' },
  };

  const STATE_LABELS: Record<PortalButtonState, string> = {
    generate: 'Generate World',
    waiting: 'Waiting...',
    enter: 'Enter World',
  };

  function renderState() {
    drawButton(STATE_LABELS[state], STATE_COLORS[state].normal);
  }

  renderState();

  // Helper: get controller/hand tip positions
  function getControllerTips(world: World): THREE.Vector3[] {
    const tips: THREE.Vector3[] = [];

    const raySpaces = world.input.xrOrigin?.raySpaces;
    if (raySpaces) {
      if (raySpaces.left) {
        tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.left.matrixWorld));
      }
      if (raySpaces.right) {
        tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.right.matrixWorld));
      }
    }

    const hands = world.input.visualAdapters?.hand;
    if (hands) {
      if (hands.left?.connected && hands.left.gripSpace) {
        tips.push(new THREE.Vector3().setFromMatrixPosition(hands.left.gripSpace.matrixWorld));
      }
      if (hands.right?.connected && hands.right.gripSpace) {
        tips.push(new THREE.Vector3().setFromMatrixPosition(hands.right.gripSpace.matrixWorld));
      }
    }

    return tips;
  }

  const _buttonBox = new THREE.Box3();

  /** Returns the state that was pressed, or null if nothing was pressed. */
  function checkPress(world: World): PortalButtonState | null {
    // Waiting state is not pressable
    if (state === 'waiting') return null;

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

    // Visual feedback
    if (anyInside && !isHovered) {
      isHovered = true;
      drawButton(STATE_LABELS[state], STATE_COLORS[state].hover);
    } else if (!anyInside && isHovered) {
      isHovered = false;
      drawButton(STATE_LABELS[state], STATE_COLORS[state].normal);
    }

    // Press on first contact
    if (anyInside && !pressedLastFrame) {
      pressedLastFrame = true;
      drawButton(STATE_LABELS[state], STATE_COLORS[state].press);
      return state;
    }

    if (!anyInside) {
      pressedLastFrame = false;
    }

    return null;
  }

  function setState(newState: PortalButtonState) {
    state = newState;
    isHovered = false;
    pressedLastFrame = false;
    renderState();
  }

  function startCountdown(durationMs: number) {
    state = 'waiting';
    isHovered = false;
    pressedLastFrame = false;
    countdownEndTime = Date.now() + durationMs;
    updateCountdown();
  }

  function updateCountdown() {
    if (state !== 'waiting') return;

    const remaining = Math.max(0, countdownEndTime - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    const timeStr = mins > 0 ? `${mins}:${s.toString().padStart(2, '0')}` : `0:${s.toString().padStart(2, '0')}`;

    drawButton(`Waiting... ${timeStr}`, '#555555');
  }

  function getState(): PortalButtonState {
    return state;
  }

  function dispose() {
    world.scene.remove(uiGroup);
    buttonGeometry.dispose();
    buttonMaterial.dispose();
    buttonTexture.dispose();
    nameTexture.dispose();
    nameMesh.geometry.dispose();
    (nameMesh.material as THREE.Material).dispose();
  }

  return { checkPress, setState, startCountdown, updateCountdown, getState, dispose };
}
