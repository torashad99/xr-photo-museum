import * as THREE from 'three';
import { World, Entity } from '@iwsdk/core';
import { InputComponent } from '@iwsdk/xr-input';
import { createVoiceNote } from './VoiceNote';
import { startStroke, addPointToStroke } from './Drawing';
import { MultiplayerService } from '../services/MultiplayerService';

export class CreativeInputSystem {
    private world: World;
    private multiplayer: MultiplayerService;

    // Left Hand State (Voice Recording)
    private leftTriggerPressed: boolean = false;
    private isRecording: boolean = false;
    private previewSphere!: THREE.Mesh;
    private recordPosition: THREE.Vector3 = new THREE.Vector3();

    // Audio capture — pre-authorized stream obtained before XR session starts
    private preAuthorizedStream: MediaStream | null = null;
    private mediaStream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];

    // Right Hand State (Drawing)
    private activeLine: THREE.Line | null = null;
    private activeLinePoints: THREE.Vector3[] = [];
    private rightTriggerPressed: boolean = false;
    private lastDrawPoint: THREE.Vector3 = new THREE.Vector3();

    // Current scene context — tags created items for context-filtered show/hide
    private context: 'museum' | 'splat' = 'museum';

    constructor(world: World, multiplayer: MultiplayerService, preAuthorizedStream?: MediaStream) {
        this.world = world;
        this.multiplayer = multiplayer;
        this.preAuthorizedStream = preAuthorizedStream ?? null;
        this.initPreviewSphere();
    }

    private initPreviewSphere() {
        const geometry = new THREE.SphereGeometry(0.1, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: 0xff4444,
            transparent: true,
            opacity: 0.5,
            wireframe: true
        });
        this.previewSphere = new THREE.Mesh(geometry, material);
        this.previewSphere.visible = false;
        this.world.scene.add(this.previewSphere);
    }

    public setContext(context: 'museum' | 'splat'): void {
        this.context = context;
    }

    public update(delta: number, time: number) {
        this.handleLeftHand();
        this.handleRightHand();
    }

    // ── Left hand (Voice Recording) ─────────────────────────────────────

    private handleLeftHand() {
        const leftGamepad = this.world.input.gamepads.left;
        let isPressed = false;
        let position: THREE.Vector3 | null = null;

        if (leftGamepad) {
            isPressed = leftGamepad.getButtonDown(InputComponent.Trigger) || leftGamepad.getButtonPressed(InputComponent.Trigger);
            const raySpace = this.world.input.xrOrigin.raySpaces.left;
            position = new THREE.Vector3().setFromMatrixPosition(raySpace.matrixWorld);
            const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(raySpace.matrixWorld));
            position.add(direction.multiplyScalar(0.5));
        }

        const leftHand = this.world.input.visualAdapters.hand.left;
        if (leftHand?.connected && leftHand.inputSource?.gamepad) {
            const pinchPressed = leftHand.inputSource.gamepad.buttons[0]?.pressed;
            if (pinchPressed) {
                isPressed = true;
                if (leftHand.gripSpace) {
                    position = new THREE.Vector3().setFromMatrixPosition(leftHand.gripSpace.matrixWorld);
                }
            }
        }

        if (isPressed) {
            if (!this.leftTriggerPressed) {
                // Trigger just pressed — start recording
                if (!this.isRecording && position) {
                    this.recordPosition.copy(position);
                    this.startRecording();
                    this.previewSphere.visible = true;
                }
            }

            // Update preview sphere position while held
            if (this.previewSphere.visible && position) {
                this.previewSphere.position.copy(position);
                this.recordPosition.copy(position);
            }

            this.leftTriggerPressed = true;
        } else {
            if (this.leftTriggerPressed) {
                // Trigger released — stop recording and place voice note
                if (this.isRecording) {
                    this.stopRecording();
                    this.previewSphere.visible = false;
                }
            }
            this.leftTriggerPressed = false;
        }
    }

    // ── Recording ──────────────────────────────────────────────────────

    private async startRecording() {
        this.isRecording = true;
        this.audioChunks = [];

        try {
            // Use pre-authorized stream if available (avoids getUserMedia during XR
            // session, which Quest Browser blocks). Fall back to fresh request for
            // non-XR / desktop usage.
            if (this.preAuthorizedStream && this.preAuthorizedStream.active) {
                this.mediaStream = this.preAuthorizedStream;
            } else if (navigator.mediaDevices?.getUserMedia) {
                this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                // Cache for future recordings
                this.preAuthorizedStream = this.mediaStream;
            } else {
                console.warn('[Voice] getUserMedia not available');
                this.isRecording = false;
                return;
            }

            if (!this.isRecording) return;

            this.mediaRecorder = new MediaRecorder(this.mediaStream);
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };
            this.mediaRecorder.start();
        } catch (e) {
            console.error('[Voice] Failed to access microphone:', e);
            this.isRecording = false;
        }
    }

    private stopRecording() {
        this.isRecording = false;
        const placePosition = this.recordPosition.clone();

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(this.audioChunks, {
                    type: this.mediaRecorder?.mimeType || 'audio/webm'
                });
                this.cleanupMic();

                if (audioBlob.size > 0) {
                    this.placeVoiceNote(placePosition, audioBlob);
                }
            };
            this.mediaRecorder.stop();
        } else {
            this.cleanupMic();
        }
    }

    private cleanupMic() {
        // Don't stop the pre-authorized stream — it's reused across recordings.
        // Only stop it if it was a fresh one-off stream.
        if (this.mediaStream && this.mediaStream !== this.preAuthorizedStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
        }
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.audioChunks = [];
    }

    private placeVoiceNote(position: THREE.Vector3, audioBlob: Blob) {
        const audioUrl = URL.createObjectURL(audioBlob);
        createVoiceNote(this.world, position, audioUrl, this.context);

        // Share with other users via multiplayer
        const reader = new FileReader();
        reader.onload = () => {
            const buffer = reader.result as ArrayBuffer;
            this.multiplayer.emitVoiceNote(
                { x: position.x, y: position.y, z: position.z },
                buffer
            );
        };
        reader.readAsArrayBuffer(audioBlob);
    }

    // ── Right hand (Drawing) ───────────────────────────────────────────

    private handleRightHand() {
        const rightGamepad = this.world.input.gamepads.right;
        let isPressed = false;
        let position: THREE.Vector3 | null = null;

        if (rightGamepad) {
            isPressed = rightGamepad.getButtonDown(InputComponent.Trigger) || rightGamepad.getButtonPressed(InputComponent.Trigger);
            const raySpace = this.world.input.xrOrigin.raySpaces.right;
            position = new THREE.Vector3().setFromMatrixPosition(raySpace.matrixWorld);
            const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(raySpace.matrixWorld));
            position.add(direction.multiplyScalar(0.05));
        }

        const rightHand = this.world.input.visualAdapters.hand.right;
        if (rightHand?.connected && rightHand.inputSource?.gamepad) {
            const pinchPressed = rightHand.inputSource.gamepad.buttons[0]?.pressed;
            if (pinchPressed) {
                isPressed = true;
                if (rightHand.gripSpace) {
                    position = new THREE.Vector3().setFromMatrixPosition(rightHand.gripSpace.matrixWorld);
                }
            }
        }

        if (isPressed && position) {
            if (!this.rightTriggerPressed) {
                const result = startStroke(this.world, 'black', position, this.context);
                this.activeLine = result.line;
                this.activeLinePoints = result.points;
                this.lastDrawPoint.copy(position);
            } else {
                if (this.activeLine && position.distanceTo(this.lastDrawPoint) > 0.01) {
                    addPointToStroke(this.activeLine, position, this.activeLinePoints);
                    this.lastDrawPoint.copy(position);
                }
            }
            this.rightTriggerPressed = true;
        } else {
            if (this.rightTriggerPressed) {
                if (this.activeLine) {
                    this.multiplayer.emitStroke(this.activeLinePoints, 'black');
                    this.activeLine = null;
                    this.activeLinePoints = [];
                }
            }
            this.rightTriggerPressed = false;
        }
    }
}
