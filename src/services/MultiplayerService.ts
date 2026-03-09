// src/services/MultiplayerService.ts
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

export interface RemoteUser {
  id: string;
  username: string;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  avatar?: THREE.Object3D;
}

export class MultiplayerService {
  private socket: Socket;
  private remoteUsers: Map<string, RemoteUser> = new Map();
  private onUserJoined: ((user: RemoteUser) => void) | null = null;
  private onUserLeft: ((userId: string) => void) | null = null;
  private onUserMoved: ((userId: string, pos: THREE.Vector3, rot: THREE.Quaternion) => void) | null = null;
  private onPhotosUpdated: ((photos: any[]) => void) | null = null;
  private onAnnotationAdded: ((annotation: any) => void) | null = null;
  private onVoiceNoteAdded: ((data: { position: { x: number, y: number, z: number }, audioData: ArrayBuffer }) => void) | null = null;

  constructor() {
    this.socket = io();
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.socket.on('userJoined', (data) => {
      const user: RemoteUser = {
        id: data.userId,
        username: data.username,
        position: new THREE.Vector3(0, 1.6, 0),
        rotation: new THREE.Quaternion()
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
        this.onUserMoved?.(data.userId, user.position, user.rotation);
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
  }

  async createRoom(username: string): Promise<{ roomId: string; inviteLink: string }> {
    return new Promise((resolve, reject) => {
      this.socket.emit('createRoom', { username }, (response: any) => {
        if (response.success) {
          resolve({
            roomId: response.roomId,
            inviteLink: response.inviteLink
          });
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
                position: new THREE.Vector3(user.position.x, user.position.y, user.position.z),
                rotation: new THREE.Quaternion(user.rotation.x, user.rotation.y, user.rotation.z, user.rotation.w)
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

  updatePosition(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.socket.emit('updatePosition', {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }
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

  emitStroke(points: THREE.Vector3[], color: string): void {
    this.socket.emit('addStroke', {
      points: points.map(p => ({ x: p.x, y: p.y, z: p.z })),
      color
    });
  }

  // Event handlers
  setOnUserJoined(callback: (user: RemoteUser) => void): void {
    this.onUserJoined = callback;
  }

  setOnUserLeft(callback: (userId: string) => void): void {
    this.onUserLeft = callback;
  }

  setOnUserMoved(callback: (userId: string, pos: THREE.Vector3, rot: THREE.Quaternion) => void): void {
    this.onUserMoved = callback;
  }

  setOnPhotosUpdated(callback: (photos: any[]) => void): void {
    this.onPhotosUpdated = callback;
  }

  setOnAnnotationAdded(callback: (annotation: any) => void): void {
    this.onAnnotationAdded = callback;
  }

  private onStrokeAdded: ((stroke: { points: { x: number, y: number, z: number }[], color: string }) => void) | null = null;
  setOnStrokeAdded(callback: (stroke: { points: { x: number, y: number, z: number }[], color: string }) => void): void {
    this.onStrokeAdded = callback;
  }

  emitVoiceNote(position: { x: number, y: number, z: number }, audioData: ArrayBuffer): void {
    this.socket.emit('addVoiceNote', { position, audioData });
  }

  setOnVoiceNoteAdded(callback: (data: { position: { x: number, y: number, z: number }, audioData: ArrayBuffer }) => void): void {
    this.onVoiceNoteAdded = callback;
  }

  getRemoteUsers(): Map<string, RemoteUser> {
    return this.remoteUsers;
  }
}
