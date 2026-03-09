// src/components/PortalFrame.ts
import * as THREE from 'three';
import { World, Entity } from '@iwsdk/core';
import { FramePosition } from './PhotoFrame';

const parallaxVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const parallaxFragmentShader = `
  uniform sampler2D uTexture;
  uniform vec2 uCameraOffset;
  uniform float uParallaxStrength;
  varying vec2 vUv;
  void main() {
    vec2 offsetUv = vUv + uCameraOffset * uParallaxStrength;
    // Clamp to avoid edge artifacts
    offsetUv = clamp(offsetUv, 0.0, 1.0);
    gl_FragColor = texture2D(uTexture, offsetUv);
  }
`;

export interface PortalFrameHandle {
  entity: Entity;
  group: THREE.Group;
  updateParallax(camera: THREE.Camera): void;
  dispose(): void;
}

export function createPortalFrame(
  world: World,
  framePos: FramePosition,
  imageUrl: string,
): PortalFrameHandle {
  const frameGroup = new THREE.Group();
  frameGroup.position.copy(framePos.position);
  frameGroup.rotation.copy(framePos.rotation);

  // Frame border — same as PhotoFrame
  const frameGeometry = new THREE.BoxGeometry(2.2, 1.7, 0.1);
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3728,
    roughness: 0.3,
    metalness: 0.5,
  });
  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  frameGroup.add(frame);

  // Parallax canvas
  const texture = new THREE.TextureLoader().load(imageUrl);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const canvasGeometry = new THREE.PlaneGeometry(2, 1.5);
  const canvasMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture },
      uCameraOffset: { value: new THREE.Vector2(0, 0) },
      uParallaxStrength: { value: 0.03 },
    },
    vertexShader: parallaxVertexShader,
    fragmentShader: parallaxFragmentShader,
    side: THREE.FrontSide,
  });
  const canvas = new THREE.Mesh(canvasGeometry, canvasMaterial);
  canvas.position.z = 0.06;
  canvas.name = 'portalCanvas';
  frameGroup.add(canvas);

  // Subtle glow border to hint it's special
  const glowGeometry = new THREE.BoxGeometry(2.3, 1.8, 0.09);
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0x6644ff,
    transparent: true,
    opacity: 0.3,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.position.z = -0.01;
  frameGroup.add(glow);

  const entity = world.createTransformEntity(frameGroup);

  // Reusable vectors for parallax calculation
  const _frameWorldPos = new THREE.Vector3();
  const _camWorldPos = new THREE.Vector3();
  const _frameRight = new THREE.Vector3();
  const _frameUp = new THREE.Vector3();

  function updateParallax(camera: THREE.Camera) {
    frameGroup.getWorldPosition(_frameWorldPos);
    camera.getWorldPosition(_camWorldPos);

    // Get frame's local axes in world space
    frameGroup.getWorldDirection(_frameRight); // this gives the frame's Z direction
    // We actually need the right and up vectors
    _frameRight.set(1, 0, 0).applyQuaternion(frameGroup.quaternion);
    _frameUp.set(0, 1, 0).applyQuaternion(frameGroup.quaternion);

    const diff = _camWorldPos.clone().sub(_frameWorldPos);

    // Project camera offset onto frame-local right and up
    const offsetX = diff.dot(_frameRight);
    const offsetY = diff.dot(_frameUp);

    canvasMaterial.uniforms.uCameraOffset.value.set(offsetX, offsetY);
  }

  function dispose() {
    texture.dispose();
    canvasMaterial.dispose();
    canvasGeometry.dispose();
    frameGeometry.dispose();
    frameMaterial.dispose();
    glowGeometry.dispose();
    glowMaterial.dispose();
    world.scene.remove(frameGroup);
  }

  return { entity, group: frameGroup, updateParallax, dispose };
}
