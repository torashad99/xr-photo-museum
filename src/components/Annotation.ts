// src/components/Annotation.ts
import * as THREE from 'three';
import { World, Entity, createComponent, Types } from '@iwsdk/core';

export const Annotation = createComponent('Annotation', {
  text: { type: Types.String, default: '' },
  authorId: { type: Types.String, default: '' },
  timestamp: { type: Types.String, default: '0' },
});

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

  // Text label (using sprite for always-facing camera)
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
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(0.5, 0.125, 1);
  sprite.position.y = 0.1;
  group.add(sprite);

  group.position.copy(position);

  // Component Data
  annotationEntity.addComponent(Annotation, {
    text: text,
    authorId: authorId,
    timestamp: Date.now().toString(),
  });

  return annotationEntity;
}