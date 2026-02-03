// src/index.ts
import { World } from '@iwsdk/core';
import * as THREE from 'three';
import { createMuseumRoom } from './components/MuseumRoom';
import { createPhotoFrame, generateFramePositions, setFramePhoto } from './components/PhotoFrame';
import { createAnnotation } from './components/Annotation';
import { GoogleAuthService } from './services/googleAuth';
import { GooglePhotosService, MediaItem } from './services/photosService'
import { MultiplayerService, RemoteUser } from './services/MultiplayerService';
import { time } from 'three/tsl';
// import { GaussianSplatWorld } from './components/GaussianSplatWorld';

class PhotoMuseumApp {
  private world!: World;
  private googleAuth: GoogleAuthService;
  private photosService: GooglePhotosService | null = null;
  private multiplayer: MultiplayerService;
  private remoteAvatars: Map<string, THREE.Object3D> = new Map();
  // private gaussianSplatWorld: GaussianSplatWorld | null = null;
  private inSplatWorld: boolean = false;

  constructor() {
    // this.world will be initialized in init()
    this.googleAuth = new GoogleAuthService();
    this.multiplayer = new MultiplayerService();

    this.init();
  }

  private async init(): Promise<void> {
    const container = document.getElementById('scene-container') as HTMLDivElement;
    if (!container) throw new Error('Scene container not found');

    this.world = await World.create(container);

    // Check for OAuth callback
    if (window.location.hash.includes('access_token')) {
      const token = this.googleAuth.handleCallback();
      if (token) {
        this.photosService = new GooglePhotosService(token);
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    // Check for room invite link
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');

    // Create museum room
    createMuseumRoom(this.world);

    // Generate photo frames
    const framePositions = generateFramePositions(18);
    framePositions.forEach((pos, index) => {
      createPhotoFrame(this.world, pos, index);
    });

    // Setup multiplayer callbacks
    this.setupMultiplayerCallbacks();

    // Join or create room
    const username = prompt('Enter your name:') || 'Anonymous';

    if (roomId) {
      await this.multiplayer.joinRoom(roomId, username);
    } else {
      const { inviteLink } = await this.multiplayer.createRoom(username);
      console.log('Share this invite link:', inviteLink);
      // Show invite link in UI
    }

    // Start render loop
    this.startRenderLoop();
  }

  private setupMultiplayerCallbacks(): void {
    this.multiplayer.setOnUserJoined((user: RemoteUser) => {
      const avatar = this.createAvatar(user.username);
      avatar.position.copy(user.position);
      this.remoteAvatars.set(user.id, avatar);
      this.world.scene.add(avatar);
    });

    this.multiplayer.setOnUserLeft((userId: string) => {
      const avatar = this.remoteAvatars.get(userId);
      if (avatar) {
        this.world.scene.remove(avatar);
        this.remoteAvatars.delete(userId);
      }
    });

    this.multiplayer.setOnUserMoved((userId, position, rotation) => {
      const avatar = this.remoteAvatars.get(userId);
      if (avatar) {
        avatar.position.copy(position);
        avatar.quaternion.copy(rotation);
      }
    });

    this.multiplayer.setOnAnnotationAdded((annotation) => {
      createAnnotation(
        this.world,
        new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z),
        annotation.text,
        annotation.color,
        annotation.userId
      );
    });
  }

  private createAvatar(username: string): THREE.Object3D {
    const group = new THREE.Group();

    // Simple avatar: head
    const headGeometry = new THREE.SphereGeometry(0.2, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.6;
    group.add(head);

    // Body
    const bodyGeometry = new THREE.CylinderGeometry(0.15, 0.2, 0.8, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 1.1;
    group.add(body);

    // Name tag
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;
    context.fillStyle = '#ffffff';
    context.font = 'bold 32px Arial';
    context.textAlign = 'center';
    context.fillText(username, 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const nameTag = new THREE.Sprite(spriteMaterial);
    nameTag.scale.set(0.5, 0.125, 1);
    nameTag.position.y = 2;
    group.add(nameTag);

    return group;
  }

  public async loadUserPhotos(): Promise<void> {
    if (!this.photosService) {
      this.googleAuth.initiateLogin();
      return;
    }

    const photos = await this.photosService.listMediaItems(18);
    // Show photo picker UI and load selected photos onto frames
  }

  // public async enterSplatWorld(splatUrl: string): Promise<void> {
  //   if (!this.gaussianSplatWorld) {
  //     this.gaussianSplatWorld = new GaussianSplatWorld(
  //       this.world.renderer,
  //       this.world.camera,
  //       this.world.scene
  //     );
  //   }

  //   await this.gaussianSplatWorld.loadSplat(splatUrl);
  //   this.inSplatWorld = true;
  // }

  // public exitSplatWorld(): void {
  //   if (this.gaussianSplatWorld) {
  //     this.gaussianSplatWorld.dispose();
  //   }
  //   this.inSplatWorld = false;
  // }

  private startRenderLoop(): void {
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      requestAnimationFrame(animate);

      // Calculate delta (in seconds) and time (in seconds)
      const delta = (currentTime - lastTime) / 1000;
      const time = currentTime / 1000;
      lastTime = currentTime;

      // Update multiplayer positions
      const camera = this.world.camera;
      this.multiplayer.updatePosition(
        camera.position,
        camera.quaternion
      );

      // // Update Gaussian splat if in splat world
      // if (this.inSplatWorld && this.gaussianSplatWorld) {
      //   this.gaussianSplatWorld.update();
      // }

      this.world.update(delta, time);
    };

    requestAnimationFrame(animate);
  }
}

// Initialize the application
new PhotoMuseumApp();