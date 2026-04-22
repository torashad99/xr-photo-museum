// src/components/PhotoFrame.ts
import * as THREE from 'three';
import { World, Entity } from '@iwsdk/core';
import { PhotoFrame } from './MuseumRoom';
import { createSlotPlusMarker } from './SlotPlusMarker';

export interface FramePosition {
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

export function createPhotoFrame(
  world: World,
  position: FramePosition,
  frameIndex: number
): Entity {
  const frameGroup = new THREE.Group();

  // Set position and rotation BEFORE creating the entity
  frameGroup.position.copy(position.position);
  frameGroup.rotation.copy(position.rotation);

  // Frame border
  const frameGeometry = new THREE.BoxGeometry(2.2, 1.7, 0.1);
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3728,
    roughness: 0.3,
    metalness: 0.5
  });
  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  frameGroup.add(frame);

  // Canvas for photo (initially white)
  const canvasGeometry = new THREE.PlaneGeometry(2, 1.5);
  const canvasMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.FrontSide
  });
  const canvas = new THREE.Mesh(canvasGeometry, canvasMaterial);
  canvas.position.z = 0.06;
  canvas.name = 'photoCanvas';
  frameGroup.add(canvas);

  // "+" overlay visible on empty slots (slots 1-17 only; slot 0 never calls createPhotoFrame)
  const plusMarker = createSlotPlusMarker(frameGroup);
  frameGroup.userData.plusMarker = plusMarker;
  frameGroup.userData.frameIndex = frameIndex;

  // Bind visuals to entity AFTER setting transform
  const frameEntity = world.createTransformEntity(frameGroup);

  // Use PhotoFrame definition from createComponent (in MuseumRoom.ts):
  frameEntity.addComponent(PhotoFrame, {
    frameIndex: frameIndex,
    photoUrl: '',
    photoId: ''
  });

  return frameEntity;
}

// Load image onto frame
export async function setFramePhoto(
  world: World,
  frameEntity: Entity,
  photoUrl: string,
  photoId: string
): Promise<void> {
  const textureLoader = new THREE.TextureLoader();

  return new Promise((resolve, reject) => {
    textureLoader.load(
      photoUrl,
      (texture) => {
        // Retrieve the Object3D from the entity
        const frameGroup = frameEntity.object3D as THREE.Group;

        if (frameGroup) {
          const canvas = frameGroup.getObjectByName('photoCanvas') as THREE.Mesh;

          if (canvas) {
            (canvas.material as THREE.MeshBasicMaterial).map = texture;
            (canvas.material as THREE.MeshBasicMaterial).color.set(0xffffff);
            (canvas.material as THREE.MeshBasicMaterial).needsUpdate = true;

            frameEntity.setValue(PhotoFrame, 'photoUrl', photoUrl);
            frameEntity.setValue(PhotoFrame, 'photoId', photoId);
          }

          // Hide the "+" once a photo is loaded
          frameGroup.userData.plusMarker?.setVisible(false);
        }
        resolve();
      },
      undefined,
      reject
    );
  });
}

/** Revert a slot back to the empty "+" state (used after world deletion). */
export function setFrameEmpty(frameEntity: Entity): void {
  const frameGroup = frameEntity.object3D as THREE.Group;
  if (!frameGroup) return;

  const canvas = frameGroup.getObjectByName('photoCanvas') as THREE.Mesh;
  if (canvas) {
    const mat = canvas.material as THREE.MeshBasicMaterial;
    if (mat.map) {
      mat.map.dispose();
      mat.map = null;
    }
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
  }

  frameEntity.setValue(PhotoFrame, 'photoUrl', '');
  frameEntity.setValue(PhotoFrame, 'photoId', '');

  // Re-show the "+" overlay
  frameGroup.userData.plusMarker?.setVisible(true);
}

// Generate frame positions around the room
export function generateFramePositions(count: number): FramePosition[] {
  const positions: FramePosition[] = [];
  const frameDepth = 0.1;
  const frameHalfDepth = frameDepth / 2; // Half depth so back is against wall
  const wallZ = -10 + frameHalfDepth; // Back wall at z = -10
  // For side walls, after 90° rotation, the frame's depth is along X axis
  const leftWallX = -10 + frameHalfDepth; // Left wall at x = -10, frame back at wall
  const rightWallX = 10 - frameHalfDepth; // Right wall at x = 10, frame back at wall
  const frameHeight = 2;
  const spacing = 3;

  // Back wall frames (facing toward camera, +Z direction)
  for (let i = 0; i < Math.min(count, 6); i++) {
    positions.push({
      position: new THREE.Vector3(-7.5 + i * spacing, frameHeight, wallZ),
      rotation: new THREE.Euler(0, 0, 0)
    });
  }

  // Left wall frames (facing +X direction, into room)
  // +Math.PI/2 around Y: local +Z → world +X
  for (let i = 6; i < Math.min(count, 12); i++) {
    positions.push({
      position: new THREE.Vector3(leftWallX, frameHeight, -7.5 + (i - 6) * spacing),
      rotation: new THREE.Euler(0, Math.PI / 2, 0)
    });
  }

  // Right wall frames (facing -X direction, into room)
  // -Math.PI/2 around Y: local +Z → world -X
  for (let i = 12; i < Math.min(count, 18); i++) {
    positions.push({
      position: new THREE.Vector3(rightWallX, frameHeight, -7.5 + (i - 12) * spacing),
      rotation: new THREE.Euler(0, -Math.PI / 2, 0)
    });
  }

  return positions;
}
