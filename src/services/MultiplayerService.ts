// src/services/MultiplayerService.ts
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

export interface PortalWorldRecord {
  frameIndex: number;
  imageUrl: string;
  imageName: string;
  photoId: string;
  state: 'waiting' | 'ready';
  operationId?: string;
  startedAt?: number;
  estimatedDurationMs?: number;
  spzUrl?: string;
  colliderMeshUrl?: string;
  rotationPreset: number;
  scale: number;
}

export interface RemoteUser {
  id: string;
  username: string;
  colorIndex: number;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  context: string;  // 'museum' | splat context string
  avatar?: THREE.Object3D;
}

export class MultiplayerService {
  private socket: Socket;
  private remoteUsers: Map<string, RemoteUser> = new Map();
  private onUserJoined: ((user: RemoteUser) => void) | null = null;
  private onUserLeft: ((userId: string) => void) | null = null;
  private onUserMoved: ((userId: string, pos: THREE.Vector3, rot: THREE.Quaternion, context: string) => void) | null = null;
  private onPhotosUpdated: ((photos: any[]) => void) | null = null;
  private onAnnotationAdded: ((annotation: any) => void) | null = null;
  private onVoiceNoteAdded: ((data: { position: { x: number, y: number, z: number }, audioData: ArrayBuffer, context?: string }) => void) | null = null;
  private onPortalWorldAdded: ((record: PortalWorldRecord) => void) | null = null;
  private onPortalWorldUpdated: ((record: PortalWorldRecord) => void) | null = null;
  private onPortalWorldRemoved: ((frameIndex: number) => void) | null = null;
  private lastPositionUpdate: number = 0;
  private readonly POSITION_THROTTLE_MS = 50; // 20 updates/sec

  constructor() {
    this.socket = io();
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.socket.on('userJoined', (data) => {
      const user: RemoteUser = {
        id: data.userId,
        username: data.username,
        colorIndex: data.colorIndex ?? 0,
        position: new THREE.Vector3(0, 1.6, 0),
        rotation: new THREE.Quaternion(),
        context: 'museum'
      };
      this.remoteUsers.set(data.userId, user);
      this.onUserJoined?.(user);
    });

    this.socket.on('userLeft', (data) => {
      this.remoteUsers.delete(data.userId);
      this.onUserLeft?.(data.userId);
    });

    this.socket.on('userMoved', (data) => {
      const user = this.remoteUsers.get(data.userId);
      if (user) {
        user.position.set(data.position.x, data.position.y, data.position.z);
        user.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z, data.rotation.w);
        user.context = data.context || 'museum';
        this.onUserMoved?.(data.userId, user.position, user.rotation, user.context);
      }
    });

    this.socket.on('photosUpdated', (photos) => {
      this.onPhotosUpdated?.(photos);
    });

    this.socket.on('annotationAdded', (annotation) => {
      this.onAnnotationAdded?.(annotation);
    });

    this.socket.on('strokeAdded', (stroke) => {
      this.onStrokeAdded?.(stroke);
    });

    this.socket.on('voiceNoteAdded', (data) => {
      this.onVoiceNoteAdded?.(data);
    });

    this.socket.on('portalWorldAdded', (record: PortalWorldRecord) => {
      this.onPortalWorldAdded?.(record);
    });

    this.socket.on('portalWorldUpdated', (record: PortalWorldRecord) => {
      this.onPortalWorldUpdated?.(record);
    });

    this.socket.on('portalWorldRemoved', (data: { frameIndex: number }) => {
      this.onPortalWorldRemoved?.(data.frameIndex);
    });
  }

  async createRoom(username: string): Promise<{ roomId: string }> {
    return new Promise((resolve, reject) => {
      this.socket.emit('createRoom', { username }, (response: any) => {
        if (response.success) {
          resolve({ roomId: response.roomId });
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  async joinRoom(roomId: string, username: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socket.emit('joinRoom', { roomId, username }, (response: any) => {
        if (response.success) {
          // Initialize remote users
          response.currentUsers.forEach((user: any) => {
            if (user.id !== response.userId) {
              this.remoteUsers.set(user.id, {
                id: user.id,
                username: user.username,
                colorIndex: user.colorIndex ?? 0,
                position: new THREE.Vector3(user.position.x, user.position.y, user.position.z),
                rotation: new THREE.Quaternion(user.rotation.x, user.rotation.y, user.rotation.z, user.rotation.w),
                context: user.context || 'museum'
              });
            }
          });
          resolve(response);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  updatePosition(position: THREE.Vector3, rotation: THREE.Quaternion, context: string = 'museum'): void {
    const now = performance.now();
    if (now - this.lastPositionUpdate < this.POSITION_THROTTLE_MS) return;
    this.lastPositionUpdate = now;
    this.socket.emit('updatePosition', {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      context
    });
  }

  updatePhotos(photos: any[]): void {
    this.socket.emit('updatePhotos', photos);
  }

  addAnnotation(annotation: { position: THREE.Vector3; text: string; color: string; userId: string }): void {
    this.socket.emit('addAnnotation', {
      userId: annotation.userId,
      position: { x: annotation.position.x, y: annotation.position.y, z: annotation.position.z },
      text: annotation.text,
      color: annotation.color
    });
  }

  emitStroke(points: THREE.Vector3[], color: string, context: string = 'museum'): void {
    this.socket.emit('addStroke', {
      points: points.map(p => ({ x: p.x, y: p.y, z: p.z })),
      color,
      context
    });
  }

  // Event handlers
  setOnUserJoined(callback: (user: RemoteUser) => void): void {
    this.onUserJoined = callback;
  }

  setOnUserLeft(callback: (userId: string) => void): void {
    this.onUserLeft = callback;
  }

  setOnUserMoved(callback: (userId: string, pos: THREE.Vector3, rot: THREE.Quaternion, context: string) => void): void {
    this.onUserMoved = callback;
  }

  setOnPhotosUpdated(callback: (photos: any[]) => void): void {
    this.onPhotosUpdated = callback;
  }

  setOnAnnotationAdded(callback: (annotation: any) => void): void {
    this.onAnnotationAdded = callback;
  }

  private onStrokeAdded: ((stroke: { points: { x: number, y: number, z: number }[], color: string, context?: string }) => void) | null = null;
  setOnStrokeAdded(callback: (stroke: { points: { x: number, y: number, z: number }[], color: string, context?: string }) => void): void {
    this.onStrokeAdded = callback;
  }

  emitVoiceNote(position: { x: number, y: number, z: number }, audioData: ArrayBuffer, context: string = 'museum'): void {
    this.socket.emit('addVoiceNote', { position, audioData, context });
  }

  setOnVoiceNoteAdded(callback: (data: { position: { x: number, y: number, z: number }, audioData: ArrayBuffer, context?: string }) => void): void {
    this.onVoiceNoteAdded = callback;
  }

  addPortalWorld(record: PortalWorldRecord): void {
    this.socket.emit('addPortalWorld', record);
  }

  updatePortalWorld(record: PortalWorldRecord): void {
    this.socket.emit('updatePortalWorld', record);
  }

  removePortalWorld(frameIndex: number): void {
    this.socket.emit('removePortalWorld', { frameIndex });
  }

  setOnPortalWorldAdded(callback: (record: PortalWorldRecord) => void): void {
    this.onPortalWorldAdded = callback;
  }

  setOnPortalWorldUpdated(callback: (record: PortalWorldRecord) => void): void {
    this.onPortalWorldUpdated = callback;
  }

  setOnPortalWorldRemoved(callback: (frameIndex: number) => void): void {
    this.onPortalWorldRemoved = callback;
  }

  getRemoteUsers(): Map<string, RemoteUser> {
    return this.remoteUsers;
  }
}
