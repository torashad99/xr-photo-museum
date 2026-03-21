// src/index.ts
import { World, Entity } from '@iwsdk/core';
import { XRInputVisualAdapter, AnimatedController, InputComponent } from '@iwsdk/xr-input';
import * as THREE from 'three';
import { createMuseumRoom } from './components/MuseumRoom';
import { createPhotoFrame, generateFramePositions, setFramePhoto } from './components/PhotoFrame';
import { createAnnotation, updateAnnotationFacing, hideAllAnnotations, showAllAnnotations } from './components/Annotation';
import { createVoiceNote, updateVoiceNoteFacing, hideAllVoiceNotes, showAllVoiceNotes, showVoiceNotesInContext, getVoiceNoteSpheres } from './components/VoiceNote';
import { GoogleAuthService } from './services/googleAuth';
import { GooglePhotosService, MediaItem } from './services/photosService'
import { MultiplayerService, RemoteUser } from './services/MultiplayerService';
import { CreativeInputSystem } from './components/CreativeInputSystem';
import { startStroke, addPointToStroke, hideAllDrawings, showAllDrawings, showDrawingsInContext } from './components/Drawing';
import { createPortalFrame, PortalFrameHandle } from './components/PortalFrame';
import { createPortalUI, PortalUIHandle, PortalButtonState } from './components/PortalUI';
import { GaussianSplatWorld } from './components/GaussianSplatWorld';
import { WorldLabsService, SplatResult } from './services/WorldLabsService';
import { FlatModeOverlay, FlatModeInput } from './components/FlatModeOverlay';

class PhotoMuseumApp {
  private world!: World;
  private googleAuth: GoogleAuthService;
  private photosService: GooglePhotosService | null = null;
  private multiplayer: MultiplayerService;
  private remoteAvatars: Map<string, THREE.Object3D> = new Map();
  private static AVATAR_COLORS = [
    0x4FC3F7, // light blue
    0xE57373, // red
    0x81C784, // green
    0xFFB74D, // orange
    0xBA68C8, // purple
    0x4DB6AC, // teal
    0xF06292, // pink
    0xAED581, // lime
  ];
  private creativeInput: CreativeInputSystem | null = null;
  private inSplatWorld: boolean = false;
  private currentSplatContext: string | null = null;

  // Portal / Splat world
  private portalFrame: PortalFrameHandle | null = null;
  private portalUI: PortalUIHandle | null = null;
  private gaussianSplatWorld: GaussianSplatWorld | null = null;
  private worldLabsService: WorldLabsService = new WorldLabsService();
  private cachedSplatResult: SplatResult | null = null;

  // Invite link display mesh on the green wall
  private inviteLinkMesh: THREE.Mesh | null = null;

  // Museum entities for hide/show
  private roomEntity: Entity | null = null;
  private floorEntity: Entity | null = null;
  private frameEntities: Entity[] = [];

  // Flat mode (mobile fallback)
  private flatMode: FlatModeOverlay | null = null;
  private flatYaw = 0;
  private flatPitch = 0;
  private flatPosition = new THREE.Vector3(0, 1.6, 0);
  private _flatRaycaster = new THREE.Raycaster();
  private _screenCenter = new THREE.Vector2(0, 0);

  // Reusable world-space position/rotation temporaries (avoids per-frame allocation)
  private _worldPos = new THREE.Vector3();
  private _worldQuat = new THREE.Quaternion();

  // XR controller raycaster for voice note interaction
  private _xrRaycaster = new THREE.Raycaster();
  private _xrRayDir = new THREE.Vector3();
  private _xrRayOrigin = new THREE.Vector3();
  // Tracks spheres currently being touched to fire onClick only once per contact
  private _touchedVoiceSpheres = new Set<THREE.Mesh>();

  // Hardcoded portal image (for debugging)
  private readonly PORTAL_IMAGE_URL = '/portal-image.jpg';
  private readonly PORTAL_IMAGE_NAME = 'Portal World';

  constructor() {
    // this.world will be initialized in init()
    this.googleAuth = new GoogleAuthService();
    this.multiplayer = new MultiplayerService();

    this.init().catch(err => console.error('[Init] Fatal error during initialization:', err));
  }

  private async init(): Promise<void> {
    const container = document.getElementById('scene-container') as HTMLDivElement;
    if (!container) throw new Error('Scene container not found');

    // Pre-authorize microphone BEFORE the XR session starts. Quest Browser
    // blocks getUserMedia once an immersive session is active, so we grab the
    // stream now and hand it to CreativeInputSystem for reuse during VR.
    const micStream = await preAuthorizeMicrophone();
    patchControllerVisualLoading();
    patchAnimatedControllerInit();

    // Detect flat mode BEFORE World.create() so we can disable XR session
    // auto-offer — phones hang when IWSDK tries to offer a session they can't support.
    const isFlatMode = await this.detectFlatMode();

    this.world = await World.create(container, {
      features: { locomotion: true },
      ...(isFlatMode ? { xr: { offer: 'none' as any } } : {}),
    });
    console.log('[Init] World created successfully');

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
      const joinResponse = await this.multiplayer.joinRoom(roomId, username);
      // Create avatars for users already in the room when we joined
      for (const [id, user] of this.multiplayer.getRemoteUsers()) {
        if (!this.remoteAvatars.has(id)) {
          const avatar = this.createAvatar(user.colorIndex, user.username);
          avatar.position.copy(user.position);
          avatar.quaternion.copy(user.rotation);
          this.remoteAvatars.set(id, avatar);
          this.world.scene.add(avatar);
        }
      }
      // Replay drawings and voice notes that existed before we joined
      if (joinResponse.drawings) {
        for (const stroke of joinResponse.drawings) {
          this.replayStroke(stroke);
        }
      }
      if (joinResponse.voiceNotes) {
        for (const vn of joinResponse.voiceNotes) {
          const audioBlob = new Blob([vn.audioData], { type: 'audio/webm' });
          const audioUrl = URL.createObjectURL(audioBlob);
          createVoiceNote(this.world, new THREE.Vector3(vn.position.x, vn.position.y, vn.position.z), audioUrl, vn.context || 'museum');
        }
      }
      // Show invite link on green wall so the joining user can share further
      this.createInviteLinkDisplay(roomId);
    } else {
      const { roomId: newRoomId } = await this.multiplayer.createRoom(username);
      const inviteLink = `${window.location.origin}?room=${newRoomId}`;
      console.log('Share this invite link:', inviteLink);
      this.createInviteLinkDisplay(newRoomId);
    }

    this.creativeInput = new CreativeInputSystem(this.world, this.multiplayer, micStream ?? undefined);

    // Setup flat mode overlay (detection already ran above before World.create)
    if (isFlatMode) {
      const overlayContainer = document.getElementById('flat-mode-overlay');
      if (overlayContainer) {
        this.flatMode = new FlatModeOverlay(overlayContainer);
        // Prevent browser gestures on the 3D canvas
        container.style.touchAction = 'none';
        // Initialize flat position from player rig
        const player = (this.world as any).player;
        if (player?.position) {
          this.flatPosition.copy(player.position);
        }
        // Show entry splash; controls hidden until user taps "Enter"
        this.flatMode.showEntryScreen();
      }
    }

    // Hook into the IWSDK's existing render loop (which uses setAnimationLoop
    // and correctly switches to XRSession.requestAnimationFrame in WebXR).
    // Do NOT use a separate requestAnimationFrame loop — it stops firing
    // once an XR session is active on Quest Browser.
    this.setupFrameHook();
  }

  private async detectFlatMode(): Promise<boolean> {
    // IWER handles localhost — never activate flat mode there
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return false;

    // No WebXR API at all (e.g. iOS Safari)
    if (!navigator.xr) return true;

    // Android Chrome reports isSessionSupported('immersive-vr') === true for
    // Cardboard-style WebXR even on phones without a headset. Detect mobile
    // phones/tablets and force flat mode — we only want real headset sessions
    // (Quest Browser), which don't have a mobile user agent.
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua)) {
      // Quest Browser UA contains "OculusBrowser" — allow XR for that
      if (!/OculusBrowser/i.test(ua)) return true;
    }

    // WebXR API exists but immersive-vr not supported
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-vr');
      return !supported;
    } catch {
      return true;
    }
  }

  private setupMultiplayerCallbacks(): void {
    this.multiplayer.setOnUserJoined((user: RemoteUser) => {
      const avatar = this.createAvatar(user.colorIndex, user.username);
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

    this.multiplayer.setOnUserMoved((userId, position, rotation, context) => {
      const avatar = this.remoteAvatars.get(userId);
      if (avatar) {
        avatar.position.copy(position);
        avatar.quaternion.copy(rotation);
        // Show avatar only when in the same world context as this local user
        const localContext = this.currentSplatContext || 'museum';
        avatar.visible = (context === localContext);
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
        audioUrl,
        data.context || 'museum'
      );
      // Re-filter so newly-arrived remote items match the viewer's current context
      showVoiceNotesInContext(this.currentSplatContext || 'museum');
    });

    this.multiplayer.setOnStrokeAdded((stroke) => {
      this.replayStroke(stroke);
      showDrawingsInContext(this.currentSplatContext || 'museum');
    });
  }

  private createAvatar(colorIndex: number, username: string): THREE.Object3D {
    const group = new THREE.Group();
    // group.position is set to the camera's world position (eye level).
    // group.quaternion tracks the remote user's camera rotation, so the capsule
    // naturally faces the direction they are looking.

    // Capsule body — server-assigned unique color per user, hangs below eye level
    const color = PhotoMuseumApp.AVATAR_COLORS[colorIndex % PhotoMuseumApp.AVATAR_COLORS.length];
    const capsuleGeometry = new THREE.CapsuleGeometry(0.15, 0.5, 8, 16);
    const capsuleMaterial = new THREE.MeshStandardMaterial({ color });
    const capsule = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
    capsule.position.y = 0;
    group.add(capsule); // children[0]

    // Eyes — black spheres on the front face of the capsule to show gaze direction
    const eyeGeometry = new THREE.SphereGeometry(0.04, 8, 8);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(-0.06, 0.05, -0.14);
    capsule.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(0.06, 0.05, -0.14);
    capsule.add(rightEye);

    // Name tag — above eye level. Use PlaneGeometry Mesh (not Sprite) for proper
    // Y-axis-only billboarding in VR (Sprite does full spherical billboard and tilts).
    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;
    ctx2d.fillStyle = 'rgba(0,0,0,0.6)';
    ctx2d.fillRect(0, 0, 256, 64);
    ctx2d.fillStyle = '#ffffff';
    ctx2d.font = 'bold 32px Arial';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(username, 128, 44);

    const texture = new THREE.CanvasTexture(canvas);
    const tagMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const nameTag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.15), tagMat);
    nameTag.position.y = 0.78;
    group.add(nameTag); // children[1]

    return group;
  }

  /** Billboard all name tags to face the camera on Y-axis only. */
  private updateNameTagFacing(camera: THREE.Camera): void {
    const camWorldPos = new THREE.Vector3();
    camera.getWorldPosition(camWorldPos);

    const parentWorldQuat = new THREE.Quaternion();
    const targetWorldQuat = new THREE.Quaternion();

    for (const avatar of this.remoteAvatars.values()) {
      if (!avatar.visible) continue;
      // The name tag is the second child (index 1); index 0 is the capsule
      const nameTag = avatar.children[1] as THREE.Mesh;
      if (!nameTag) continue;

      const tagWorldPos = new THREE.Vector3();
      nameTag.getWorldPosition(tagWorldPos);

      // Desired world-space Y rotation to face camera
      const dx = camWorldPos.x - tagWorldPos.x;
      const dz = camWorldPos.z - tagWorldPos.z;
      targetWorldQuat.setFromEuler(new THREE.Euler(0, Math.atan2(dx, dz), 0));

      // Convert to local quaternion: localQuat = parentWorldQuat^-1 * targetWorldQuat
      // This cancels out whatever rotation the avatar group contributes.
      avatar.getWorldQuaternion(parentWorldQuat);
      parentWorldQuat.invert();
      nameTag.quaternion.copy(parentWorldQuat).multiply(targetWorldQuat);
    }
  }

  /** Show/hide all remote avatars based on whether they share the local user's context. */
  private updateAvatarVisibilityForContext(): void {
    const localContext = this.currentSplatContext || 'museum';
    for (const [id, user] of this.multiplayer.getRemoteUsers()) {
      const avatar = this.remoteAvatars.get(id);
      if (avatar) {
        avatar.visible = (user.context === localContext);
      }
    }
  }

  private replayStroke(stroke: { points: { x: number; y: number; z: number }[]; color: string; context?: string }): void {
    if (!stroke.points || stroke.points.length === 0) return;
    const firstPoint = new THREE.Vector3(stroke.points[0].x, stroke.points[0].y, stroke.points[0].z);
    const { line, points } = startStroke(this.world, stroke.color, firstPoint, stroke.context || 'museum');
    for (let i = 1; i < stroke.points.length; i++) {
      const p = new THREE.Vector3(stroke.points[i].x, stroke.points[i].y, stroke.points[i].z);
      addPointToStroke(line, p, points);
    }
  }

  private createInviteLinkDisplay(roomId: string): void {
    // Build the invite URL using the current origin (works on localhost AND any network/hosted URL)
    const inviteLink = `${window.location.origin}?room=${roomId}`;

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Invite others to join:', canvas.width / 2, 50);

    // Room code large and green
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 72px monospace';
    ctx.fillText(roomId, canvas.width / 2, 148);

    // Full URL smaller
    ctx.fillStyle = '#cccccc';
    ctx.font = '26px Arial';
    ctx.fillText(inviteLink, canvas.width / 2, 210);

    const texture = new THREE.CanvasTexture(canvas);
    const geometry = new THREE.PlaneGeometry(5, 1.25);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);

    // Green wall is front wall at z=10, facing -Z into the room
    mesh.position.set(0, 4.0, 9.94);
    mesh.rotation.set(0, Math.PI, 0);

    this.world.scene.add(mesh);
    this.inviteLinkMesh = mesh;
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
  private async enterSplatWorld(splatContext?: string): Promise<void> {
    if (!this.portalUI || !this.cachedSplatResult) return;
    const ctx = splatContext ?? `splat:${this.PORTAL_IMAGE_URL}`;

    const result = this.cachedSplatResult;

    try {
      console.log('[SplatWorld] Entering with spzUrl:', result.spzUrl);

      // Hide museum entities
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

      // Hide museum drawings, voice notes, and invite link; splat ones will be shown as they're created
      hideAllAnnotations();
      showVoiceNotesInContext(ctx); // hides museum, shows this splat (initially empty)
      showDrawingsInContext(ctx);   // hides museum, shows this splat (initially empty)
      if (this.inviteLinkMesh) this.inviteLinkMesh.visible = false;
      this.currentSplatContext = ctx;

      // Switch creative input to splat context so new items are tagged correctly
      this.creativeInput?.setContext(ctx);

      // Load splat
      this.gaussianSplatWorld = new GaussianSplatWorld(this.world);
      await this.gaussianSplatWorld.loadSplat(result.spzUrl);

      console.log('[SplatWorld] Splat loaded successfully');

      // Position player at splat origin via locomotor.teleport()
      const locomotor = this.getLocomotor();
      if (locomotor) {
        locomotor.teleport(new THREE.Vector3(0, 1.6, 0));
      }

      // Stop ALL locomotion systems (slide + teleport + turn).
      // They may be registered as separate systems, so stopping just
      // LocomotionSystem isn't enough — TeleportSystem would still show
      // its arc/reticle, and SlideSystem would fight with flyPosition.
      for (const sys of this.getLocomotionSystemsToStop()) sys.stop();

      this.inSplatWorld = true;
      this.updateAvatarVisibilityForContext();

      // Show "Return to Museum" button and vertical buttons in flat mode
      this.flatMode?.setReturnButtonVisible(true);
      this.flatMode?.setVerticalButtonsVisible(true);

    } catch (err) {
      console.error('[SplatWorld] Failed to enter splat world:', err);
    }
  }

  private exitSplatWorld(): void {
    // Re-enable full locomotion (slide + teleport + turn) for the gallery
    for (const sys of this.getLocomotionSystemsToStop()) sys.play();

    // Dispose splat
    this.gaussianSplatWorld?.dispose();
    this.gaussianSplatWorld = null;

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

    // Restore museum drawings, annotations, voice notes, and invite link; hide splat ones
    showAllAnnotations();
    showVoiceNotesInContext('museum');
    showDrawingsInContext('museum');
    if (this.inviteLinkMesh) this.inviteLinkMesh.visible = true;

    // Switch creative input back to museum context
    this.creativeInput?.setContext('museum');
    this.currentSplatContext = null;

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

    // Reposition player in front of portal frame via locomotor.teleport()
    // so the locomotor's internal state is updated (prevents it from
    // overwriting player.position on the next frame).
    const locomotor = this.getLocomotor();
    if (locomotor) {
      locomotor.teleport(new THREE.Vector3(portalPos.position.x, 1.6, portalPos.position.z + 2));
    } else {
      // Fallback if locomotor not found
      const player = (this.world as any).player;
      if (player?.position) player.position.set(portalPos.position.x, 1.6, portalPos.position.z + 2);
    }

    this.inSplatWorld = false;
    this.updateAvatarVisibilityForContext();

    // Hide "Return to Museum" button and vertical buttons in flat mode
    this.flatMode?.setReturnButtonVisible(false);
    this.flatMode?.setVerticalButtonsVisible(false);

    // Reset flat mode position to in front of portal
    if (this.flatMode) {
      const fps = generateFramePositions(18);
      const pp = fps[0];
      this.flatPosition.set(pp.position.x, 1.6, pp.position.z + 2);
    }
  }

  /** Access IWSDK's internal locomotor for programmatic teleport. */
  private getLocomotor(): any {
    const systems = (this.world as any)._systems || (this.world as any).systems;
    if (systems) {
      for (const sys of systems) {
        if (sys.locomotor) return sys.locomotor;
      }
    }
    return null;
  }

  /**
   * Find all locomotion-related systems (LocomotionSystem, TeleportSystem,
   * SlideSystem, TurnSystem). They may be registered independently, so
   * stopping just the parent LocomotionSystem isn't enough.
   */
  /** Systems to stop in splat world (everything except TurnSystem). */
  private getLocomotionSystemsToStop(): any[] {
    const systems = (this.world as any)._systems || (this.world as any).systems;
    if (!systems) return [];
    const STOP_NAMES = ['LocomotionSystem', 'TeleportSystem', 'SlideSystem'];
    return [...systems].filter(
      (sys: any) => sys.locomotor || STOP_NAMES.includes(sys.constructor?.name),
    );
  }

  // ── Flat mode: camera rotation ──
  private applyFlatModeCamera(input: FlatModeInput, _delta: number): void {
    const sensitivity = 0.003; // radians per pixel of screen drag
    this.flatYaw -= input.lookDelta.x * sensitivity;
    this.flatPitch -= input.lookDelta.y * sensitivity;

    if (!this.inSplatWorld) {
      this.flatPitch = THREE.MathUtils.clamp(this.flatPitch, -Math.PI / 3, Math.PI / 3);
    } else {
      this.flatPitch = THREE.MathUtils.clamp(this.flatPitch, -Math.PI * 4 / 9, Math.PI * 4 / 9);
    }

    // Yaw on the player rig, pitch on the camera
    const player = (this.world as any).player;
    if (player?.quaternion) {
      player.quaternion.setFromEuler(new THREE.Euler(0, this.flatYaw, 0));
    }
    this.world.camera.rotation.x = this.flatPitch;
  }

  // ── Flat mode: gallery movement ──
  private applyFlatModeMovement(input: FlatModeInput, delta: number): void {
    const speed = 3.0; // m/s
    const deadZone = 0.15;

    let mx = Math.abs(input.leftStick.x) > deadZone ? input.leftStick.x : 0;
    let my = Math.abs(input.leftStick.y) > deadZone ? input.leftStick.y : 0;

    if (mx !== 0 || my !== 0) {
      const fwd = new THREE.Vector3(-Math.sin(this.flatYaw), 0, -Math.cos(this.flatYaw));
      const right = new THREE.Vector3(Math.cos(this.flatYaw), 0, -Math.sin(this.flatYaw));

      this.flatPosition.addScaledVector(right, mx * speed * delta);
      this.flatPosition.addScaledVector(fwd, -my * speed * delta);

      // Clamp to museum walls (20×20 room, walls at ±10)
      this.flatPosition.x = THREE.MathUtils.clamp(this.flatPosition.x, -9.5, 9.5);
      this.flatPosition.z = THREE.MathUtils.clamp(this.flatPosition.z, -9.5, 9.5);
    }

    this.flatPosition.y = 0.5; // Eye height for flat mode

    const player = (this.world as any).player;
    if (player?.position) {
      player.position.copy(this.flatPosition);
    }
  }

  /**
   * Check if any controller tip is touching a voice note sphere and fire
   * onClick on first contact (same proximity model as the portal button).
   * Called each frame only while in the gallery and splat world.
   */
  private handleVoiceNoteXRInteraction(): void {
    const spheres = getVoiceNoteSpheres();
    if (spheres.length === 0) {
      this._touchedVoiceSpheres.clear();
      return;
    }

    // Collect all controller/hand tip positions
    const tips: THREE.Vector3[] = [];
    const raySpaces = (this.world.input as any).xrOrigin?.raySpaces;
    if (raySpaces?.left)  tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.left.matrixWorld));
    if (raySpaces?.right) tips.push(new THREE.Vector3().setFromMatrixPosition(raySpaces.right.matrixWorld));
    const hands = this.world.input.visualAdapters?.hand;
    if (hands?.left?.connected && hands.left.gripSpace)
      tips.push(new THREE.Vector3().setFromMatrixPosition(hands.left.gripSpace.matrixWorld));
    if (hands?.right?.connected && hands.right.gripSpace)
      tips.push(new THREE.Vector3().setFromMatrixPosition(hands.right.gripSpace.matrixWorld));

    const TOUCH_RADIUS = 0.12; // sphere radius 0.06 + 0.06 tolerance

    for (const sphere of spheres) {
      const center = new THREE.Vector3().setFromMatrixPosition(sphere.matrixWorld);
      const isTouching = tips.some(tip => tip.distanceTo(center) < TOUCH_RADIUS);

      if (isTouching && !this._touchedVoiceSpheres.has(sphere)) {
        // First contact — fire
        this._touchedVoiceSpheres.add(sphere);
        sphere.userData.onClick?.();
      } else if (!isTouching) {
        this._touchedVoiceSpheres.delete(sphere);
      }
    }
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

      // ── Flat mode: camera + movement (runs in both gallery and splat) ──
      if (this.flatMode) {
        const flatInput = this.flatMode.getInput();

        this.applyFlatModeCamera(flatInput, delta);

        if (!this.inSplatWorld) {
          // Gallery: flat mode movement
          this.applyFlatModeMovement(flatInput, delta);
        } else {
          // Splat world: feed virtual sticks to GaussianSplatWorld
          this.gaussianSplatWorld?.setFlatInput(flatInput.leftStick, flatInput.verticalInput);

          // Return to Museum button
          if (flatInput.returnPressed) {
            this.exitSplatWorld();
          }
        }

        // ── Common frame logic (shared between flat and XR) ──
        if (!this.inSplatWorld) {
          camera.getWorldPosition(this._worldPos);
          camera.getWorldQuaternion(this._worldQuat);
          this.multiplayer.updatePosition(this._worldPos, this._worldQuat, this.currentSplatContext || 'museum');
          updateAnnotationFacing(camera);
          updateVoiceNoteFacing(camera);
          this.updateNameTagFacing(camera);
          this.portalFrame?.updateParallax(camera);
          this.portalUI?.updateCountdown();

          // Raycast interaction: reticle → tap anywhere
          this._flatRaycaster.setFromCamera(this._screenCenter, camera);

          // Reticle hover feedback — portal button OR voice note sphere
          const buttonMesh = this.portalUI?.getButtonMesh();
          const voiceSpheresFlat = getVoiceNoteSpheres();
          let reticleActive = false;
          if (buttonMesh) {
            reticleActive = this._flatRaycaster.intersectObject(buttonMesh).length > 0;
          }
          if (!reticleActive && voiceSpheresFlat.length > 0) {
            reticleActive = this._flatRaycaster.intersectObjects(voiceSpheresFlat).length > 0;
          }
          this.flatMode.setReticleActive(reticleActive);

          const pressed = this.portalUI?.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed);
          if (pressed === 'generate') {
            this.generateSplatWorld();
          } else if (pressed === 'enter') {
            this.enterSplatWorld();
          }

          // Voice note playback in flat mode
          if (flatInput.interactPressed && voiceSpheresFlat.length > 0) {
            const hits = this._flatRaycaster.intersectObjects(voiceSpheresFlat);
            if (hits.length > 0) hits[0].object.userData.onClick?.();
          }
        } else {
          // Splat world: free-fly + flat input already fed above
          // Still broadcast position so remote users see this user moving in the splat world
          camera.getWorldPosition(this._worldPos);
          camera.getWorldQuaternion(this._worldQuat);
          this.multiplayer.updatePosition(this._worldPos, this._worldQuat, this.currentSplatContext || 'museum');
          updateVoiceNoteFacing(camera);
          this.updateNameTagFacing(camera);

          // Voice note raycast + reticle in splat world (same as museum branch)
          this._flatRaycaster.setFromCamera(this._screenCenter, camera);
          const voiceSpheresSplat = getVoiceNoteSpheres();
          const reticleActiveSplat = voiceSpheresSplat.length > 0 &&
            this._flatRaycaster.intersectObjects(voiceSpheresSplat).length > 0;
          this.flatMode.setReticleActive(reticleActiveSplat);

          if (flatInput.interactPressed && voiceSpheresSplat.length > 0) {
            const hits = this._flatRaycaster.intersectObjects(voiceSpheresSplat);
            if (hits.length > 0) hits[0].object.userData.onClick?.();
          }

          this.gaussianSplatWorld?.update(delta);
        }
      } else {
        // ── XR mode (original behavior) ──
        if (!this.inSplatWorld) {
          camera.getWorldPosition(this._worldPos);
          camera.getWorldQuaternion(this._worldQuat);
          this.multiplayer.updatePosition(this._worldPos, this._worldQuat, this.currentSplatContext || 'museum');
          this.creativeInput?.update(delta, time);
          updateAnnotationFacing(camera);
          updateVoiceNoteFacing(camera);
          this.updateNameTagFacing(camera);
          this.portalFrame?.updateParallax(camera);
          this.portalUI?.updateCountdown();

          const pressed = this.portalUI?.checkPress(this.world);
          if (pressed === 'generate') {
            this.generateSplatWorld();
          } else if (pressed === 'enter') {
            this.enterSplatWorld();
          }

          // Voice note playback: controller touch
          this.handleVoiceNoteXRInteraction();
        } else {
          // Splat world XR: drawing + voice recording + voice playback all active
          // Still broadcast position so remote users see this user in the splat world
          camera.getWorldPosition(this._worldPos);
          camera.getWorldQuaternion(this._worldQuat);
          this.multiplayer.updatePosition(this._worldPos, this._worldQuat, this.currentSplatContext || 'museum');
          this.creativeInput?.update(delta, time);
          updateVoiceNoteFacing(camera);
          this.updateNameTagFacing(camera);
          this.handleVoiceNoteXRInteraction();

          this.gaussianSplatWorld?.update(delta);

          if (this.gaussianSplatWorld?.checkMenuPress()) {
            this.exitSplatWorld();
          }
        }
      }
    };
  }
}

/**
 * Monkey-patch XRInputVisualAdapter.prototype.connectVisual to add error
 * handling (the original has no .catch()) and disable frustum culling on
 * loaded controller meshes (r181 ArrayCamera culling fix).
 */
function patchControllerVisualLoading(): void {
  (XRInputVisualAdapter.prototype as any).connectVisual = function (this: any) {
    if (!this.inputConfig) return;
    const { inputSource, layout } = this.inputConfig;
    (XRInputVisualAdapter as any)
      .createVisual(
        this.visualClass, inputSource, layout,
        this.visualsEnabled, this.scene, this.camera, this.assetLoader,
      )
      .then((visual: any) => {
        if (
          visual &&
          inputSource === this._inputSource &&
          visual.constructor === this.visualClass
        ) {
          this.visual = visual;
          this.visual.xrInput = this;
          this.playerSpace.add(visual.model);

          // Disable frustum culling on all meshes (fixes r181 ArrayCamera culling)
          visual.model.traverse((child: any) => {
            if (child.isMesh) child.frustumCulled = false;
            if (child.isBatchedMesh) child.perObjectFrustumCulled = false;
          });
        }
      })
      .catch((err: any) => {
        console.warn('Controller visual loading failed:', err);
      });
  };
}

/**
 * Monkey-patch AnimatedController.prototype.init to skip FlexBatchedMesh
 * conversion entirely. On Quest Browser with WebXR multiview, BatchedMesh
 * triggers GL_ANGLE_multi_draw which conflicts with GL_OVR_multiview
 * extension ordering in GLSL ES 3.0 shaders, causing all controller
 * materials to fail compilation. Keeping raw GLTF meshes avoids this.
 * Trade-off: no button press animations, but controllers are visible.
 */
function patchAnimatedControllerInit(): void {
  (AnimatedController.prototype as any).init = function (this: any) {
    // Skip origInit entirely (FlexBatchedMesh creation) — just fix raw meshes
    this.model.traverse((child: any) => {
      if (child.isMesh) child.frustumCulled = false;
    });
  };
}

/**
 * Request microphone access before the XR session starts. Quest Browser blocks
 * getUserMedia during active immersive sessions, so we obtain the stream early.
 * The returned MediaStream stays active and is reused for voice note recordings.
 */
async function preAuthorizeMicrophone(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn('[Mic] getUserMedia not available on this device');
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log('[Mic] Microphone pre-authorized successfully');
    return stream;
  } catch (e) {
    console.warn('[Mic] Microphone permission denied or unavailable:', e);
    return null;
  }
}

// Initialize the application
new PhotoMuseumApp();