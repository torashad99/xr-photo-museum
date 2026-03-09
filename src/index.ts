// src/index.ts
import { World, Entity } from '@iwsdk/core';
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
import { createPortalFrame, PortalFrameHandle } from './components/PortalFrame';
import { createPortalUI, PortalUIHandle, PortalButtonState } from './components/PortalUI';
import { GaussianSplatWorld } from './components/GaussianSplatWorld';
import { createBoundaryGuard, BoundaryGuardHandle } from './components/BoundaryGuard';
import { WorldLabsService, SplatResult } from './services/WorldLabsService';

class PhotoMuseumApp {
  private world!: World;
  private googleAuth: GoogleAuthService;
  private photosService: GooglePhotosService | null = null;
  private multiplayer: MultiplayerService;
  private remoteAvatars: Map<string, THREE.Object3D> = new Map();
  private creativeInput: CreativeInputSystem | null = null;
  private inSplatWorld: boolean = false;

  // Portal / Splat world
  private portalFrame: PortalFrameHandle | null = null;
  private portalUI: PortalUIHandle | null = null;
  private gaussianSplatWorld: GaussianSplatWorld | null = null;
  private boundaryGuard: BoundaryGuardHandle | null = null;
  private worldLabsService: WorldLabsService = new WorldLabsService();
  private cachedSplatResult: SplatResult | null = null;

  // Museum entities for hide/show
  private roomEntity: Entity | null = null;
  private floorEntity: Entity | null = null;
  private frameEntities: Entity[] = [];

  // Hardcoded portal image (for debugging)
  private readonly PORTAL_IMAGE_URL = '/portal-image.jpg';
  private readonly PORTAL_IMAGE_NAME = 'Portal World';

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
    const { roomEntity, floorEntity } = createMuseumRoom(this.world);
    this.roomEntity = roomEntity;
    this.floorEntity = floorEntity;

    // Generate photo frames — skip index 0 (reserved for portal)
    const framePositions = generateFramePositions(18);
    framePositions.forEach((pos, index) => {
      if (index === 0) return; // Portal frame goes here instead
      const entity = createPhotoFrame(this.world, pos, index);
      this.frameEntities.push(entity);
    });

    // Create portal frame at position 0 (back wall center)
    const portalPos = framePositions[0];
    this.portalFrame = createPortalFrame(this.world, portalPos, this.PORTAL_IMAGE_URL);

    // Check cache to determine initial button state
    const cached = await this.worldLabsService.checkCache(this.PORTAL_IMAGE_URL);
    let initialPortalState: PortalButtonState = 'generate';
    if (cached) {
      this.cachedSplatResult = cached;
      initialPortalState = 'enter';
    }

    this.portalUI = createPortalUI(
      this.world,
      portalPos.position,
      portalPos.rotation,
      this.PORTAL_IMAGE_NAME,
      initialPortalState,
    );

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

  private isGenerating = false;

  /** Phase 1: Start world generation, show countdown, poll until done. */
  private async generateSplatWorld(): Promise<void> {
    if (!this.portalUI || this.isGenerating) return;
    this.isGenerating = true;

    try {
      const genResult = await this.worldLabsService.startGeneration(
        this.PORTAL_IMAGE_URL,
        this.PORTAL_IMAGE_NAME,
      );

      // Server returned cached result directly
      if ('spzUrl' in genResult) {
        this.cachedSplatResult = genResult;
        this.portalUI.setState('enter');
        this.isGenerating = false;
        return;
      }

      // Start countdown timer on the button
      this.portalUI.startCountdown(genResult.estimatedDurationMs);

      // Poll in background until done
      const result = await this.worldLabsService.pollUntilDone(
        genResult.operationId,
        this.PORTAL_IMAGE_URL,
      );

      this.cachedSplatResult = result;
      this.portalUI.setState('enter');
    } catch (err) {
      console.error('Failed to generate world:', err);
      this.portalUI?.setState('generate');
    } finally {
      this.isGenerating = false;
    }
  }

  /** Phase 2: Load the cached splat and enter the world. */
  private async enterSplatWorld(): Promise<void> {
    if (!this.portalUI || !this.cachedSplatResult) return;

    const result = this.cachedSplatResult;

    try {
      console.log('[SplatWorld] Entering with spzUrl:', result.spzUrl);

      // Hide museum entities (but keep floor for locomotion raycasting —
      // hiding it makes IWSDK's raycast miss → player falls with gravity).
      if (this.roomEntity?.object3D) this.roomEntity.object3D.visible = false;
      for (const entity of this.frameEntities) {
        if (entity.object3D) entity.object3D.visible = false;
      }
      if (this.portalFrame) this.portalFrame.group.visible = false;
      this.portalUI.dispose();
      this.portalUI = null;

      // Make floor invisible but keep it raycastable for IWSDK locomotion
      if (this.floorEntity?.object3D) {
        const floorMesh = this.floorEntity.object3D as THREE.Mesh;
        if (floorMesh.material && 'opacity' in floorMesh.material) {
          (floorMesh.material as THREE.MeshStandardMaterial).transparent = true;
          (floorMesh.material as THREE.MeshStandardMaterial).opacity = 0;
        }
      }

      // Load splat
      this.gaussianSplatWorld = new GaussianSplatWorld(this.world);
      await this.gaussianSplatWorld.loadSplat(result.spzUrl);

      console.log('[SplatWorld] Splat loaded successfully');

      // Position player at splat origin
      const player = (this.world as any).player;
      if (player?.position) {
        player.position.set(0, 1.6, 0);
      }

      // Create boundary guard
      this.boundaryGuard = createBoundaryGuard(this.world, new THREE.Vector3(0, 0, 0), 5);
      this.inSplatWorld = true;

    } catch (err) {
      console.error('[SplatWorld] Failed to enter splat world:', err);
    }
  }

  private exitSplatWorld(): void {
    // Dispose splat + boundary
    this.gaussianSplatWorld?.dispose();
    this.gaussianSplatWorld = null;
    this.boundaryGuard?.dispose();
    this.boundaryGuard = null;

    // Re-show museum entities
    if (this.roomEntity?.object3D) this.roomEntity.object3D.visible = true;
    // Restore floor visibility
    if (this.floorEntity?.object3D) {
      const floorMesh = this.floorEntity.object3D as THREE.Mesh;
      if (floorMesh.material && 'opacity' in floorMesh.material) {
        (floorMesh.material as THREE.MeshStandardMaterial).transparent = false;
        (floorMesh.material as THREE.MeshStandardMaterial).opacity = 1;
      }
    }
    for (const entity of this.frameEntities) {
      if (entity.object3D) entity.object3D.visible = true;
    }
    if (this.portalFrame) this.portalFrame.group.visible = true;

    // Re-create portal UI — splat is cached now so go straight to "Enter World"
    const framePositions = generateFramePositions(18);
    const portalPos = framePositions[0];
    this.portalUI = createPortalUI(
      this.world,
      portalPos.position,
      portalPos.rotation,
      this.PORTAL_IMAGE_NAME,
      this.cachedSplatResult ? 'enter' : 'generate',
    );

    // Reposition player in front of portal frame
    const player = (this.world as any).player;
    if (player?.position) {
      player.position.set(portalPos.position.x, 1.6, portalPos.position.z + 2);
    }

    this.inSplatWorld = false;
  }

  private setupFrameHook(): void {
    // Wrap world.update so our per-frame logic runs inside the IWSDK's
    // setAnimationLoop callback — which uses XRSession.requestAnimationFrame
    // in WebXR and therefore keeps firing on Quest Browser.
    const originalUpdate = this.world.update.bind(this.world);
    this.world.update = (delta: number, time: number) => {
      // Run the original IWSDK update first (processes input, ECS systems, etc.)
      originalUpdate(delta, time);

      const camera = this.world.camera;

      if (!this.inSplatWorld) {
        // ── Gallery mode ──

        // Sync local camera pose to other users
        this.multiplayer.updatePosition(camera.position, camera.quaternion);

        // Update creative input (drawing & annotations)
        this.creativeInput?.update(delta, time);

        // Rotate labels to face the camera on Y-axis only
        updateAnnotationFacing(camera);
        updateVoiceNoteFacing(camera);

        // Update portal parallax
        this.portalFrame?.updateParallax(camera);

        // Update countdown timer if waiting
        this.portalUI?.updateCountdown();

        // Check portal button press — dispatch based on which state was pressed
        const pressed = this.portalUI?.checkPress(this.world);
        if (pressed === 'generate') {
          this.generateSplatWorld();
        } else if (pressed === 'enter') {
          this.enterSplatWorld();
        }
      } else {
        // ── Splat world mode ──

        // Free-fly controls
        this.gaussianSplatWorld?.update(delta);

        // Boundary guard
        if (this.boundaryGuard) {
          this.boundaryGuard.update(this.world);
          if (this.boundaryGuard.checkReturn(this.world)) {
            this.exitSplatWorld();
          }
        }
      }
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