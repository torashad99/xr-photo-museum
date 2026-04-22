import * as THREE from 'three';
import { World } from '@iwsdk/core';

export function getControllerTips(world: World): THREE.Vector3[] {
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
