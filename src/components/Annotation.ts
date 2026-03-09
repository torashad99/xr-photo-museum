// src/components/Annotation.ts
import * as THREE from 'three';
import { World, Entity, createComponent, Types } from '@iwsdk/core';

export const Annotation = createComponent('Annotation', {
  text: { type: Types.String, default: '' },
  authorId: { type: Types.String, default: '' },
  timestamp: { type: Types.String, default: '0' },
});

// Track all annotation groups for per-frame Y-axis facing and hide/show
const annotationLabels: Set<THREE.Mesh> = new Set();
const annotationGroups: Set<THREE.Group> = new Set();

export function createAnnotation(
  world: World,
  position: THREE.Vector3,
  text: string,
  color: string,
  authorId: string
): Entity {
  const group = new THREE.Group();

  // Bind the visual group immediately
  const annotationEntity = world.createTransformEntity(group);

  // Pin/Marker
  const pinGeometry = new THREE.SphereGeometry(0.05, 16, 16);
  const pinMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
  const pin = new THREE.Mesh(pinGeometry, pinMaterial);
  group.add(pin);

  // Text label — use a Mesh (PlaneGeometry) instead of Sprite so we can
  // control rotation per-axis (Y-only billboard, not full spherical).
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  canvas.width = 256;
  canvas.height = 64;

  context.fillStyle = 'rgba(0, 0, 0, 0.7)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.font = '24px Arial';
  context.textAlign = 'center';
  context.fillText(text.substring(0, 30), canvas.width / 2, 40);

  const texture = new THREE.CanvasTexture(canvas);
  const labelGeometry = new THREE.PlaneGeometry(0.5, 0.125);
  const labelMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const label = new THREE.Mesh(labelGeometry, labelMaterial);
  label.name = 'annotationLabel';
  label.position.y = 0.1;
  group.add(label);

  annotationLabels.add(label);
  annotationGroups.add(group);

  group.position.copy(position);

  // Component Data
  annotationEntity.addComponent(Annotation, {
    text: text,
    authorId: authorId,
    timestamp: Date.now().toString(),
  });

  return annotationEntity;
}

const _labelWorld = new THREE.Vector3();
const _camWorld = new THREE.Vector3();

/**
 * Rotate all annotation labels to face the camera on the Y-axis only
 * (cylindrical billboard). Call once per frame.
 */
export function updateAnnotationFacing(camera: THREE.Camera): void {
  camera.getWorldPosition(_camWorld);

  for (const label of annotationLabels) {
    // Skip disposed labels
    if (!label.parent) {
      annotationLabels.delete(label);
      continue;
    }

    label.getWorldPosition(_labelWorld);

    const dx = _camWorld.x - _labelWorld.x;
    const dz = _camWorld.z - _labelWorld.z;
    // PlaneGeometry faces +Z by default; atan2(dx, dz) gives the Y rotation
    // needed to point the plane's +Z toward the camera.
    label.rotation.set(0, Math.atan2(dx, dz), 0);
  }
}

export function hideAllAnnotations(): void {
  for (const group of annotationGroups) {
    if (group.parent) group.visible = false;
  }
}

export function showAllAnnotations(): void {
  for (const group of annotationGroups) {
    if (group.parent) group.visible = true;
  }
}
