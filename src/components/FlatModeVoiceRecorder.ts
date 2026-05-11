import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { createVoiceNote } from './VoiceNote';
import { MultiplayerService } from '../services/MultiplayerService';

export class FlatModeVoiceRecorder {
  private world: World;
  private multiplayer: MultiplayerService;
  private container: HTMLElement;
  private banner: HTMLDivElement | null = null;

  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private _isRecording = false;

  private context = 'museum';

  constructor(world: World, multiplayer: MultiplayerService, container: HTMLElement) {
    this.world = world;
    this.multiplayer = multiplayer;
    this.container = container;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  setContext(ctx: string): void {
    this.context = ctx;
  }

  async startRecording(): Promise<void> {
    if (this._isRecording) return;
    this._isRecording = true;
    this.audioChunks = [];

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this._isRecording) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        return;
      }

      this.mediaRecorder = new MediaRecorder(this.mediaStream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.start();
      this.showBanner();
    } catch (e) {
      console.error('[FlatVoice] Microphone access failed:', e);
      this._isRecording = false;
    }
  }

  stopRecording(camera: THREE.Camera): void {
    if (!this._isRecording) return;
    this._isRecording = false;
    this.hideBanner();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, {
          type: this.mediaRecorder?.mimeType || 'audio/webm',
        });
        this.cleanup();
        if (blob.size > 0) this.placeVoiceNote(blob, camera);
      };
      this.mediaRecorder.stop();
    } else {
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  private placeVoiceNote(audioBlob: Blob, camera: THREE.Camera): void {
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    camera.getWorldPosition(worldPos);
    camera.getWorldQuaternion(worldQuat);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuat);
    const pos = worldPos.add(dir.multiplyScalar(2));

    const audioUrl = URL.createObjectURL(audioBlob);
    createVoiceNote(this.world, pos, audioUrl, this.context);

    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      this.multiplayer.emitVoiceNote(
        { x: pos.x, y: pos.y, z: pos.z },
        buffer,
        this.context,
      );
    };
    reader.readAsArrayBuffer(audioBlob);
  }

  private showBanner(): void {
    const banner = document.createElement('div');
    banner.className = 'flat-recording-banner';

    const dot = document.createElement('div');
    dot.className = 'flat-recording-dot';
    banner.appendChild(dot);

    const label = document.createElement('div');
    label.className = 'flat-recording-label';
    label.textContent = 'Recording...';
    banner.appendChild(label);

    const stopBtn = document.createElement('button');
    stopBtn.className = 'flat-recording-stop';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Camera will be passed by the caller via stopRecording
      this._stopRequested = true;
    });
    banner.appendChild(stopBtn);

    this.container.appendChild(banner);
    this.banner = banner;
  }

  private hideBanner(): void {
    if (this.banner) {
      this.banner.remove();
      this.banner = null;
    }
  }

  // Flag checked by the frame loop to know when user tapped stop
  private _stopRequested = false;
  get stopRequested(): boolean {
    const val = this._stopRequested;
    this._stopRequested = false;
    return val;
  }

  /** Programmatic stop (e.g., from keyboard shortcut). Mirrors the banner's Stop button. */
  requestStop(): void {
    if (this._isRecording) this._stopRequested = true;
  }
}
