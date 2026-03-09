// src/index.ts
import { World } from '@iwsdk/core';
import * as THREE from 'three';
import { createMuseumRoom } from './components/MuseumRoom';
import { createPhotoFrame, generateFramePositions, setFramePhoto } from './components/PhotoFrame';
import { createAnnotation, updateAnnotationFacing } from './components/Annotation';
import { createVoiceNote, updateVoiceNoteFacing } from './components/VoiceNote';
import { GoogleAuthService } from './services/googleAuth';
import { GooglePhotosService, MediaItem } from './services/photosService'
import { MultiplayerService, RemoteUser } from './services/MultiplayerService';
import { CreativeInputSystem } from './components/CreativeInputSystem';
import { startStroke, addPointToStroke } from './components/Drawing';
// import { GaussianSplatWorld } from './components/GaussianSplatWorld';

class PhotoMuseumApp {
  private world!: World;
  private googleAuth: GoogleAuthService;
  private photosService: GooglePhotosService | null = null;
  private multiplayer: MultiplayerService;
  private remoteAvatars: Map<string, THREE.Object3D> = new Map();
  private creativeInput: CreativeInputSystem | null = null;
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

    // Inject 'microphone' into XR session features BEFORE World.create()
    // so the auto-offered session includes mic access. Quest Browser blocks
    // SpeechRecognition / getUserMedia during immersive sessions without it.
    injectXRMicrophoneFeature();

    this.world = await World.create(container, { features: { locomotion: true } });

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
    // prompt() is unreliable in Quest Browser's VR mode — it may block
    // the thread or be invisible while wearing the headset.
    const urlUsername = urlParams.get('name');
    const username = urlUsername || 'User_' + Math.random().toString(36).substring(2, 7);

    if (roomId) {
      await this.multiplayer.joinRoom(roomId, username);
    } else {
      const { inviteLink } = await this.multiplayer.createRoom(username);
      console.log('Share this invite link:', inviteLink);
      // Show invite link in UI
    }

    this.creativeInput = new CreativeInputSystem(this.world, this.multiplayer);

    // Hook into the IWSDK's existing render loop (which uses setAnimationLoop
    // and correctly switches to XRSession.requestAnimationFrame in WebXR).
    // Do NOT use a separate requestAnimationFrame loop — it stops firing
    // once an XR session is active on Quest Browser.
    this.setupFrameHook();
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

    this.multiplayer.setOnVoiceNoteAdded((data) => {
      const audioBlob = new Blob([data.audioData], { type: 'audio/webm' });
      const audioUrl = URL.createObjectURL(audioBlob);
      createVoiceNote(
        this.world,
        new THREE.Vector3(data.position.x, data.position.y, data.position.z),
        audioUrl
      );
    });

    this.multiplayer.setOnStrokeAdded((stroke) => {
      // Recreate remote stroke
      const firstPoint = new THREE.Vector3(stroke.points[0].x, stroke.points[0].y, stroke.points[0].z);
      const { line, points } = startStroke(this.world, stroke.color, firstPoint);

      // Add rest of points
      for (let i = 1; i < stroke.points.length; i++) {
        const p = new THREE.Vector3(stroke.points[i].x, stroke.points[i].y, stroke.points[i].z);
        addPointToStroke(line, p, points);
      }
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

  private setupFrameHook(): void {
    // Wrap world.update so our per-frame logic runs inside the IWSDK's
    // setAnimationLoop callback — which uses XRSession.requestAnimationFrame
    // in WebXR and therefore keeps firing on Quest Browser.
    const originalUpdate = this.world.update.bind(this.world);
    this.world.update = (delta: number, time: number) => {
      // Run the original IWSDK update first (processes input, ECS systems, etc.)
      originalUpdate(delta, time);

      // Sync local camera pose to other users
      const camera = this.world.camera;
      this.multiplayer.updatePosition(
        camera.position,
        camera.quaternion
      );

      // Update creative input (drawing & annotations)
      this.creativeInput?.update(delta, time);

      // Rotate labels to face the camera on Y-axis only
      updateAnnotationFacing(camera);
      updateVoiceNoteFacing(camera);
    };
  }
}

/**
 * Monkey-patch navigator.xr session methods to include the 'microphone'
 * optional feature. The IWSDK's XRFeatureOptions doesn't expose a microphone
 * field, but Quest Browser requires it for mic access during immersive sessions.
 */
function injectXRMicrophoneFeature(): void {
  if (!navigator.xr) return;

  const patchInit = (init?: XRSessionInit): XRSessionInit => {
    init = init || {};
    const opts = init.optionalFeatures ? [...init.optionalFeatures] : [];
    if (!opts.includes('microphone')) opts.push('microphone');
    return { ...init, optionalFeatures: opts };
  };

  const origRequest = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = (mode: XRSessionMode, init?: XRSessionInit) =>
    origRequest(mode, patchInit(init));

  if ('offerSession' in navigator.xr) {
    const origOffer = (navigator.xr as any).offerSession.bind(navigator.xr);
    (navigator.xr as any).offerSession = (mode: string, init?: XRSessionInit) =>
      origOffer(mode, patchInit(init));
  }
}

// Initialize the application
new PhotoMuseumApp();