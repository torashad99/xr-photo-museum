// src/components/MuseumRoom.ts
import * as THREE from 'three';
import { World, Entity, createComponent, Types, LocomotionEnvironment } from '@iwsdk/core';

// Museum Room tag component
export const MuseumRoom = createComponent('MuseumRoom', {
  // Empty schema
});

// Photo Frame component
export const PhotoFrame = createComponent('PhotoFrame', {
  photoUrl: { type: Types.String, default: '' },
  photoId: { type: Types.String, default: '' },
  frameIndex: { type: Types.Int8, default: 0 },
});

export function createMuseumRoom(world: World): { roomEntity: Entity; floorEntity: Entity } {

  // Create room geometry
  const roomGroup = new THREE.Group();

  // NOTE: createTransformEntity likely binds the Group to the Entity internally.
  // We do not need to call addObject3D manually after this.
  const roomEntity = world.createTransformEntity(roomGroup);

  // Floor — needs its own entity for LocomotionEnvironment
  const floorGeometry = new THREE.PlaneGeometry(20, 20);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x8B4513,
    roughness: 0.8
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const floorEntity = world.createTransformEntity(floor);
  floorEntity.addComponent(LocomotionEnvironment);

  // Walls — each with different color
  const wallColors = [
    0xFF0000,  // Red — Back wall
    0x00FF00,  // Green — Front wall
    0x0000FF,  // Blue — Left wall
    0xFFA500,  // Orange — Right wall
  ];

  const wallPositions = [
    { pos: [0, 2.5, -10], rot: [0, 0, 0] },      // Back wall
    { pos: [0, 2.5, 10], rot: [0, Math.PI, 0] },  // Front wall
    { pos: [-10, 2.5, 0], rot: [0, Math.PI / 2, 0] },  // Left wall
    { pos: [10, 2.5, 0], rot: [0, -Math.PI / 2, 0] },  // Right wall
  ];

  wallPositions.forEach(({ pos, rot }, index) => {
    const wallGeometry = new THREE.PlaneGeometry(20, 5);
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: wallColors[index],
      roughness: 0.9
    });
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(pos[0], pos[1], pos[2]);
    wall.rotation.set(rot[0], rot[1], rot[2]);
    wall.receiveShadow = true;
    roomGroup.add(wall);
  });

  // Ceiling
  const ceilingGeometry = new THREE.PlaneGeometry(20, 20);
  const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xFFFFFF });
  const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 5;
  roomGroup.add(ceiling);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  roomGroup.add(ambientLight);

  // Spot lights for picture frames
  const spotLight = new THREE.SpotLight(0xffffff, 1);
  spotLight.position.set(0, 4.5, 0);
  spotLight.castShadow = true;
  roomGroup.add(spotLight);

  // FIX: Use entity.addComponent instead of world.addComponent
  // Assuming MuseumRoom is the Component definition
  roomEntity.addComponent(MuseumRoom);

  return { roomEntity, floorEntity };
}