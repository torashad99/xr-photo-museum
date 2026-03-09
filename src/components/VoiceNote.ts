import * as THREE from 'three';
import { World, Entity, createComponent, Types } from '@iwsdk/core';

export const VoiceNoteComponent = createComponent('VoiceNote', {
    audioUrl: { type: Types.String, default: '' },
    authorId: { type: Types.String, default: '' },
});

// Track all voice note labels for Y-axis billboard facing
const voiceNoteLabels: Set<THREE.Mesh> = new Set();

export function createVoiceNote(
    world: World,
    position: THREE.Vector3,
    audioUrl: string
): Entity {
    const group = new THREE.Group();
    const entity = world.createTransformEntity(group);

    // Speaker icon sphere
    const sphereGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    group.add(sphere);

    // Pulsing rings to indicate audio
    const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff6666,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.02;
    group.add(ring);

    // "Voice Note" label
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff4444';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('🔊 Voice Note', canvas.width / 2, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const labelGeo = new THREE.PlaneGeometry(0.4, 0.1);
    const labelMat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.name = 'voiceNoteLabel';
    label.position.y = 0.12;
    group.add(label);

    voiceNoteLabels.add(label);

    group.position.copy(position);

    // Store audio and set up click-to-play
    const audio = new Audio(audioUrl);
    group.userData.audio = audio;
    group.userData.playing = false;

    // Make clickable — toggle playback on ray intersection
    sphere.userData.onClick = () => {
        if (group.userData.playing) {
            audio.pause();
            audio.currentTime = 0;
            group.userData.playing = false;
            sphereMat.color.setHex(0xff4444);
        } else {
            audio.play();
            group.userData.playing = true;
            sphereMat.color.setHex(0x44ff44);
            audio.onended = () => {
                group.userData.playing = false;
                sphereMat.color.setHex(0xff4444);
            };
        }
    };

    entity.addComponent(VoiceNoteComponent, { audioUrl });

    return entity;
}

const _labelWorld = new THREE.Vector3();
const _camWorld = new THREE.Vector3();

/**
 * Rotate all voice note labels to face the camera on Y-axis only.
 * Call once per frame.
 */
export function updateVoiceNoteFacing(camera: THREE.Camera): void {
    camera.getWorldPosition(_camWorld);

    for (const label of voiceNoteLabels) {
        if (!label.parent) {
            voiceNoteLabels.delete(label);
            continue;
        }

        label.getWorldPosition(_labelWorld);
        const dx = _camWorld.x - _labelWorld.x;
        const dz = _camWorld.z - _labelWorld.z;
        label.rotation.set(0, Math.atan2(dx, dz), 0);
    }
}
