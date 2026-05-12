// src/index.ts
import { World, Entity, launchXR } from '@iwsdk/core';
import { XRInputVisualAdapter, AnimatedController, InputComponent } from '@iwsdk/xr-input';
import * as THREE from 'three';
import { createMuseumRoom, PhotoFrame } from './components/MuseumRoom';
import { createPhotoFrame, generateFramePositions, setFramePhoto, setFrameEmpty } from './components/PhotoFrame';
import { SlotPlusMarkerHandle } from './components/SlotPlusMarker';
import { createAnnotation, updateAnnotationFacing, hideAllAnnotations, showAllAnnotations } from './components/Annotation';
import { createVoiceNote, updateVoiceNoteFacing, hideAllVoiceNotes, showAllVoiceNotes, showVoiceNotesInContext, getVoiceNoteSpheres } from './components/VoiceNote';
import { GoogleAuthService } from './services/googleAuth';
import { GooglePhotosService, MediaItem } from './services/photosService'
import { MultiplayerService, RemoteUser, PortalWorldRecord } from './services/MultiplayerService';
import { CreativeInputSystem } from './components/CreativeInputSystem';
import { startStroke, addPointToStroke, hideAllDrawings, showAllDrawings, showDrawingsInContext } from './components/Drawing';
import { createPortalFrame, PortalFrameHandle } from './components/PortalFrame';
import { createPortalUI, PortalUIHandle, PortalButtonState, PortalUIOptions } from './components/PortalUI';
import { createPhotoPicker, PhotoPickerHandle } from './components/PhotoPicker';
import { createSplatAdjustPanel, SplatAdjustPanelHandle } from './components/SplatAdjustPanel';
import { createTrashConfirmDialog, TrashConfirmHandle } from './components/TrashConfirmDialog';
import { GaussianSplatWorld } from './components/GaussianSplatWorld';
import { WorldLabsService, SplatResult } from './services/WorldLabsService';
import { FlatModeOverlay, FlatModeInput } from './components/FlatModeOverlay';
import { FlatModeDrawing } from './components/FlatModeDrawing';
import { FlatModeVoiceRecorder } from './components/FlatModeVoiceRecorder';
import './styles/flat-mode.css';

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
  private currentSplatFrameIndex: number | null = null;

  // Portal / Splat world (slot 0 — legacy hardcoded path)
  private portalFrame: PortalFrameHandle | null = null;
  private portalUI: PortalUIHandle | null = null;
  private gaussianSplatWorld: GaussianSplatWorld | null = null;
  private worldLabsService: WorldLabsService = new WorldLabsService();
  private cachedSplatResult: SplatResult | null = null;

  // Generalized asset pipeline — slots 1-17
  private adjustPanel: SplatAdjustPanelHandle | null = null;
  private photoPicker: PhotoPickerHandle | null = null;
  private targetedFrameIndex: number | null = null;
  private portalUIHandlesByFrame = new Map<number, PortalUIHandle>();
  private portalFrameHandlesByFrame = new Map<number, PortalFrameHandle>();
  private portalWorldsByFrame = new Map<number, PortalWorldRecord>();
  private generatingFrameIndices = new Set<number>();
  private trashDialogsByFrame = new Map<number, TrashConfirmHandle>();

  // Invite link display mesh on the green wall
  private inviteLinkMesh: THREE.Mesh | null = null;

  // Museum entities for hide/show
  private roomEntity: Entity | null = null;
  private floorEntity: Entity | null = null;
  private frameEntities: Entity[] = [];

  // Flat mode (mobile fallback)
  private flatMode: FlatModeOverlay | null = null;
  private flatDrawing: FlatModeDrawing | null = null;
  private flatVoiceRecorder: FlatModeVoiceRecorder | null = null;
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

    // Always disable auto-offer — we gate XR entry behind an intro screen on headsets,
    // and flat mode never enters XR.
    this.world = await World.create(container, {
      features: { locomotion: true },
      xr: { offer: 'none' as any },
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
    let roomId = urlParams.get('room');

    // Auto-detect server link mode when no ?room= param is present
    if (!roomId) {
      try {
        const resp = await fetch('/api/link-room');
        if (resp.ok) {
          const data = await resp.json();
          if (data.room) {
            roomId = data.room;
            window.history.replaceState({}, '', `?room=${roomId}`);
          }
        }
      } catch {
        // Server not in link mode or unreachable — proceed to createRoom normally
      }
    }

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
      { withTrash: false },
    );

    // Setup multiplayer callbacks
    this.setupMultiplayerCallbacks();

    // Join or create room
    // prompt() is unreliable in Quest Browser's VR mode — it may block
    // the thread or be invisible while wearing the headset.
    const urlUsername = urlParams.get('name');
    const username = urlUsername || 'User_' + Math.random().toString(36).substring(2, 7);

    if (roomId) {
      let joinedRoomId = roomId;
      try {
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
        if (joinResponse.portalWorlds) {
          for (const record of joinResponse.portalWorlds) {
            await this.applyRemotePortalWorld(record);
          }
        }
      } catch (err) {
        // Room not found (server restarted, stale link, etc.) — create a fresh one
        console.warn('[Init] Could not join room, creating new one:', err);
        const { roomId: newRoomId } = await this.multiplayer.createRoom(username);
        joinedRoomId = newRoomId;
        window.history.replaceState({}, '', `?room=${joinedRoomId}`);
      }
      // Always show the invite banner regardless of join/fallback path
      const inviteLink = `${window.location.origin}?room=${joinedRoomId}`;
      console.log('Share this invite link:', inviteLink);
      this.createInviteLinkDisplay(joinedRoomId);
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

        // Initialize flat-mode creative tools
        const tapZone = overlayContainer.querySelector('.flat-tap-zone') as HTMLElement;
        if (tapZone) {
          this.flatDrawing = new FlatModeDrawing(this.world, this.multiplayer, tapZone);
          this.flatMode.setOnDrawToggle((active) => {
            if (active) {
              this.flatDrawing!.setCamera(this.world.scene.getObjectByProperty('isCamera', true) as THREE.Camera);
              this.flatDrawing!.enter();
            } else {
              this.flatDrawing!.exit();
            }
          });
        }

        this.flatVoiceRecorder = new FlatModeVoiceRecorder(this.world, this.multiplayer, overlayContainer);
        this.flatMode.setOnMicToggle(() => {
          if (this.flatVoiceRecorder!.isRecording) {
            // Toggle off — same path as the Stop banner button (kept for mobile users)
            this.flatVoiceRecorder!.requestStop();
            return;
          }
          this.flatMode!.setMicActive(true);
          this.flatVoiceRecorder!.startRecording();
        });
      }
    } else {
      // XR-capable device (Quest headset) — show intro screen before entering VR.
      // launchXR must be called inside the user gesture (pointerdown/click) because
      // Quest Browser requires requestSession to originate from a user activation.
      const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (!isLocalhost) {
        this.showXRIntroScreen(() => launchXR(this.world));
      } else {
        launchXR(this.world);
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

  private showXRIntroScreen(onEnter: () => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'xr-intro-splash';

    const title = document.createElement('div');
    title.className = 'xr-intro-title';
    title.textContent = 'XR Photo Museum';
    overlay.appendChild(title);

    const msg = document.createElement('div');
    msg.className = 'xr-intro-message';
    msg.textContent = "Photos can't be uploaded from the headset yet. Visit the link below from iOS, Android, or Desktop to upload photos.";
    overlay.appendChild(msg);

    const roomUrl = window.location.href;
    const link = document.createElement('div');
    link.className = 'xr-intro-link';
    link.textContent = roomUrl;
    overlay.appendChild(link);

    const btn = document.createElement('button');
    btn.className = 'xr-intro-btn';
    btn.textContent = 'Enter VR Experience';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      overlay.remove();
      onEnter();
    });
    overlay.appendChild(btn);

    document.body.appendChild(overlay);
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

    this.multiplayer.setOnPortalWorldAdded((record) => {
      this.applyRemotePortalWorld(record);
    });

    this.multiplayer.setOnPortalWorldUpdated((record) => {
      this.applyRemotePortalWorld(record);
    });

    this.multiplayer.setOnPortalWorldRemoved((frameIndex) => {
      this.applyRemotePortalWorldRemoved(frameIndex);
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

  /** Slot 0 enter — shim that builds a synthetic record and delegates to the unified path. */
  private async enterSplatWorld(): Promise<void> {
    if (!this.cachedSplatResult) return;
    await this.enterSplatForRecord({
      frameIndex: 0,
      imageUrl: this.PORTAL_IMAGE_URL,
      imageName: this.PORTAL_IMAGE_NAME,
      photoId: '',
      state: 'ready',
      spzUrl: this.cachedSplatResult.spzUrl,
      colliderMeshUrl: this.cachedSplatResult.colliderMeshUrl,
      rotationPreset: 1,
      scale: 1.5,
    });
  }

  /** Unified enter path for both slot 0 and slots 1-17. */
  private async enterSplatForRecord(record: PortalWorldRecord): Promise<void> {
    if (!record.spzUrl) return;
    const ctx = `splat:${record.imageUrl}`;
    this.currentSplatFrameIndex = record.frameIndex;

    try {
      console.log('[SplatWorld] Entering slot', record.frameIndex, 'spzUrl:', record.spzUrl);

      // Hide museum entities
      if (this.roomEntity?.object3D) this.roomEntity.object3D.visible = false;
      for (const entity of this.frameEntities) {
        if (entity.object3D) entity.object3D.visible = false;
      }

      // Always hide slot-0 portal frame (part of museum visuals)
      if (this.portalFrame) this.portalFrame.group.visible = false;

      // Hide all slot 1-17 portal frames
      for (const [, pfh] of this.portalFrameHandlesByFrame) {
        pfh.group.visible = false;
      }

      // Hide ALL PortalUI handles — they live independently in world.scene
      this.portalUI?.setVisible(false);
      for (const [fi, slotUI] of this.portalUIHandlesByFrame) {
        if (fi === record.frameIndex) {
          // Dispose active slot's UI so it's re-created in 'enter' state on exit
          slotUI.dispose();
          this.portalUIHandlesByFrame.delete(fi);
        } else {
          slotUI.setVisible(false);
        }
      }

      // For slot 0, dispose the scalar portalUI when entering slot 0
      if (record.frameIndex === 0) {
        this.portalUI?.dispose();
        this.portalUI = null;
      }

      // Make floor invisible but keep it raycastable for IWSDK locomotion
      if (this.floorEntity?.object3D) {
        const floorMesh = this.floorEntity.object3D as THREE.Mesh;
        if (floorMesh.material && 'opacity' in floorMesh.material) {
          (floorMesh.material as THREE.MeshStandardMaterial).transparent = true;
          (floorMesh.material as THREE.MeshStandardMaterial).opacity = 0;
        }
      }

      // Dismiss photo picker if open
      this.photoPicker?.dispose();
      this.photoPicker = null;
      this.targetedFrameIndex = null;

      // Hide museum drawings, voice notes, and invite link
      hideAllAnnotations();
      showVoiceNotesInContext(ctx);
      showDrawingsInContext(ctx);
      if (this.inviteLinkMesh) this.inviteLinkMesh.visible = false;
      this.currentSplatContext = ctx;
      this.creativeInput?.setContext(ctx);
      this.flatDrawing?.setContext(ctx);
      this.flatVoiceRecorder?.setContext(ctx);

      // Load splat with per-slot rotation/scale
      this.gaussianSplatWorld = new GaussianSplatWorld(this.world);
      await this.gaussianSplatWorld.loadSplat(record.spzUrl, {
        rotationPreset: record.rotationPreset,
        scale: record.scale,
      });

      console.log('[SplatWorld] Splat loaded successfully');

      // Spawn in-world orientation/scale adjust panel (only for slots 1-17)
      if (record.frameIndex !== 0) {
        this.adjustPanel = createSplatAdjustPanel(
          this.world,
          this.world.camera,
          this.gaussianSplatWorld,
          (preset, scale) => this.saveSlotFix(record.frameIndex, preset, scale),
        );
      }

      const locomotor = this.getLocomotor();
      if (locomotor) {
        locomotor.teleport(new THREE.Vector3(0, 1.6, 0));
      }

      // Stop ALL locomotion systems (slide + teleport + turn).
      for (const sys of this.getLocomotionSystemsToStop()) sys.stop();

      this.inSplatWorld = true;
      this.updateAvatarVisibilityForContext();

      this.flatMode?.setReturnButtonVisible(true);
      this.flatMode?.setVerticalButtonsVisible(true);
      this.flatMode?.setInSplatWorld(true);

    } catch (err) {
      console.error('[SplatWorld] Failed to enter splat world:', err);
      this.currentSplatFrameIndex = null;
    }
  }

  private exitSplatWorld(): void {
    for (const sys of this.getLocomotionSystemsToStop()) sys.play();

    this.adjustPanel?.dispose();
    this.adjustPanel = null;

    this.gaussianSplatWorld?.dispose();
    this.gaussianSplatWorld = null;

    // Re-show museum entities
    if (this.roomEntity?.object3D) this.roomEntity.object3D.visible = true;
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

    // Re-show all portal frames
    if (this.portalFrame) this.portalFrame.group.visible = true;
    for (const [, pfh] of this.portalFrameHandlesByFrame) pfh.group.visible = true;

    // Re-show all PortalUI handles (hidden on enter; slot 0's may be null if we entered slot 0)
    this.portalUI?.setVisible(true);
    for (const [, slotUI] of this.portalUIHandlesByFrame) slotUI.setVisible(true);

    showAllAnnotations();
    showVoiceNotesInContext('museum');
    showDrawingsInContext('museum');
    if (this.inviteLinkMesh) this.inviteLinkMesh.visible = true;
    this.creativeInput?.setContext('museum');
    this.flatDrawing?.setContext('museum');
    this.flatVoiceRecorder?.setContext('museum');
    this.currentSplatContext = null;

    // Restore the PortalUI for whichever frame we just exited
    const exitedFrameIndex = this.currentSplatFrameIndex;
    this.currentSplatFrameIndex = null;
    const framePositions = generateFramePositions(18);

    let returnPos: THREE.Vector3;
    if (exitedFrameIndex === null || exitedFrameIndex === 0) {
      // Slot 0 legacy path
      const portalPos = framePositions[0];
      this.portalUI = createPortalUI(
        this.world,
        portalPos.position,
        portalPos.rotation,
        this.PORTAL_IMAGE_NAME,
        this.cachedSplatResult ? 'enter' : 'generate',
        { withTrash: false },
      );
      returnPos = new THREE.Vector3(portalPos.position.x, 1.6, portalPos.position.z + 2);
    } else {
      // Slot 1-17: re-create PortalUI in 'enter' state
      const record = this.portalWorldsByFrame.get(exitedFrameIndex);
      const slotPos = framePositions[exitedFrameIndex];
      if (record) {
        const slotUI = createPortalUI(
          this.world,
          slotPos.position,
          slotPos.rotation,
          record.imageName,
          'enter',
        );
        this.portalUIHandlesByFrame.set(exitedFrameIndex, slotUI);
      }
      returnPos = new THREE.Vector3(slotPos.position.x, 1.6, slotPos.position.z + 2);
    }

    const locomotor = this.getLocomotor();
    if (locomotor) {
      locomotor.teleport(returnPos);
    } else {
      const player = (this.world as any).player;
      if (player?.position) player.position.copy(returnPos);
    }

    this.inSplatWorld = false;
    this.updateAvatarVisibilityForContext();

    this.flatMode?.setReturnButtonVisible(false);
    this.flatMode?.setVerticalButtonsVisible(false);
    this.flatMode?.setInSplatWorld(false);

    if (this.flatMode) {
      this.flatPosition.copy(returnPos);
    }
  }

  // ── Generalized asset pipeline ──

  /** Helper: find frame entity by frameIndex. */
  private getFrameEntity(frameIndex: number): Entity | undefined {
    return this.frameEntities.find(
      e => (e.object3D as THREE.Group)?.userData.frameIndex === frameIndex,
    );
  }

  /** Open the world-space photo picker for the given slot. */
  private openPhotoPicker(frameIndex: number): void {
    if (this.targetedFrameIndex === frameIndex && this.photoPicker) return;
    this.photoPicker?.dispose();
    this.photoPicker = null;
    this.targetedFrameIndex = frameIndex;

    const frameEntity = this.getFrameEntity(frameIndex);
    if (!frameEntity) return;
    const fg = frameEntity.object3D as THREE.Group;

    this.photoPicker = createPhotoPicker(
      this.world,
      fg.position.clone(),
      fg.rotation.clone(),
      {
        onSelect: (photoUrl, photoId, photoName) => {
          this.onPhotoSelected(frameIndex, photoUrl, photoId, photoName);
        },
        onCancel: () => {
          this.photoPicker?.dispose();
          this.photoPicker = null;
          this.targetedFrameIndex = null;
        },
      },
    );
  }

  /** Called once a photo is chosen from the picker. */
  private async onPhotoSelected(
    frameIndex: number,
    photoUrl: string,
    photoId: string,
    photoName: string,
  ): Promise<void> {
    this.photoPicker?.dispose();
    this.photoPicker = null;
    this.targetedFrameIndex = null;

    const frameEntity = this.getFrameEntity(frameIndex);
    if (!frameEntity) return;

    await setFramePhoto(this.world, frameEntity, photoUrl, photoId);

    // Stash photo metadata on userData so startSlotGeneration can read it
    const fg = frameEntity.object3D as THREE.Group;
    fg.userData.currentPhotoUrl = photoUrl;
    fg.userData.currentPhotoId = photoId;
    fg.userData.currentPhotoName = photoName;

    // Create or replace PortalUI for this slot in 'generate' state
    this.portalUIHandlesByFrame.get(frameIndex)?.dispose();
    const framePositions = generateFramePositions(18);
    const slotUI = createPortalUI(
      this.world,
      framePositions[frameIndex].position,
      framePositions[frameIndex].rotation,
      photoName,
      'generate',
    );
    if (this.inSplatWorld) slotUI.setVisible(false);
    this.portalUIHandlesByFrame.set(frameIndex, slotUI);
  }

  /** Start generating a World Labs splat for a slot (slots 1-17). */
  private async startSlotGeneration(frameIndex: number): Promise<void> {
    if (this.generatingFrameIndices.has(frameIndex)) return;

    const frameEntity = this.getFrameEntity(frameIndex);
    if (!frameEntity) return;
    const fg = frameEntity.object3D as THREE.Group;
    let imageUrl = fg?.userData.currentPhotoUrl as string | undefined;
    const imageName = fg?.userData.currentPhotoName as string | undefined;
    if (!imageUrl) return;

    this.generatingFrameIndices.add(frameIndex);

    // blob: URLs are local-only — upload to server first so World Labs can fetch them
    if (imageUrl.startsWith('blob:')) {
      try {
        const hostedUrl = await this.worldLabsService.uploadBlobPhoto(imageUrl, imageName ?? 'photo.jpg');
        fg.userData.currentPhotoUrl = hostedUrl;
        imageUrl = hostedUrl;
      } catch (err) {
        console.error('[Pipeline] Photo upload failed:', err);
        this.generatingFrameIndices.delete(frameIndex);
        return;
      }
    }

    const record: PortalWorldRecord = {
      frameIndex,
      imageUrl,
      imageName: imageName ?? 'My World',
      photoId: fg?.userData.currentPhotoId as string ?? '',
      state: 'waiting',
      startedAt: Date.now(),
      estimatedDurationMs: 60_000,
      rotationPreset: 1,
      scale: 1.5,
    };
    this.portalWorldsByFrame.set(frameIndex, record);
    this.multiplayer.addPortalWorld(record);

    const framePositions = generateFramePositions(18);
    const slotPos = framePositions[frameIndex];

    const slotUI = this.portalUIHandlesByFrame.get(frameIndex);
    slotUI?.startCountdown(60_000);

    try {
      const genResult = await this.worldLabsService.startGeneration(imageUrl, record.imageName);

      if ('spzUrl' in genResult) {
        // Cache hit — immediately ready
        record.state = 'ready';
        record.spzUrl = genResult.spzUrl;
        record.colliderMeshUrl = genResult.colliderMeshUrl;
        this.portalWorldsByFrame.set(frameIndex, record);
        this.multiplayer.updatePortalWorld(record);
        slotUI?.setState('enter');
      } else {
        record.operationId = genResult.operationId;
        slotUI?.startCountdown(genResult.estimatedDurationMs);
        this.multiplayer.updatePortalWorld(record);

        const result = await this.worldLabsService.pollUntilDone(genResult.operationId, imageUrl);
        record.state = 'ready';
        record.spzUrl = result.spzUrl;
        record.colliderMeshUrl = result.colliderMeshUrl;
        this.portalWorldsByFrame.set(frameIndex, record);
        this.multiplayer.updatePortalWorld(record);
        slotUI?.setState('enter');
      }
    } catch (err) {
      console.error(`[Pipeline] Generation failed for slot ${frameIndex}:`, err);
      // Revert to photo state
      this.portalWorldsByFrame.delete(frameIndex);
      this.multiplayer.removePortalWorld(frameIndex);
      slotUI?.setState('generate');
    } finally {
      this.generatingFrameIndices.delete(frameIndex);
    }
  }

  /** Enter the generated splat world for a specific slot (slots 1-17). */
  private enterSlotSplat(frameIndex: number): void {
    const record = this.portalWorldsByFrame.get(frameIndex);
    if (!record || record.state !== 'ready' || !record.spzUrl) return;
    this.enterSplatForRecord(record);
  }

  /** Persist the orientation/scale fix from the adjust panel to the record. */
  private saveSlotFix(frameIndex: number, preset: number, scale: number): void {
    const record = this.portalWorldsByFrame.get(frameIndex);
    if (!record) return;
    record.rotationPreset = preset;
    record.scale = scale;
    this.multiplayer.updatePortalWorld(record);
    console.log(`[Pipeline] Slot ${frameIndex} fix saved: preset=${preset} scale=${scale}`);
  }

  /** Show the YES/NO trash confirmation dialog for a slot. */
  private openTrashConfirm(frameIndex: number): void {
    // Only one dialog per frame at a time
    if (this.trashDialogsByFrame.has(frameIndex)) return;

    const framePositions = generateFramePositions(18);
    const slotPos = framePositions[frameIndex];
    const dialog = createTrashConfirmDialog(
      this.world,
      slotPos.position,
      slotPos.rotation,
    );
    this.trashDialogsByFrame.set(frameIndex, dialog);
  }

  /** Execute the trash action for a slot: clear server cache, notify peers, reset to empty. */
  private confirmDelete(frameIndex: number): void {
    const record = this.portalWorldsByFrame.get(frameIndex);

    // Best-effort server cache clear
    if (record) {
      this.worldLabsService.deleteCache(record.imageUrl).catch(() => {});
      this.multiplayer.removePortalWorld(frameIndex);
    }

    // Dispose PortalUI + PortalFrame
    this.portalUIHandlesByFrame.get(frameIndex)?.dispose();
    this.portalUIHandlesByFrame.delete(frameIndex);
    this.portalFrameHandlesByFrame.get(frameIndex)?.dispose();
    this.portalFrameHandlesByFrame.delete(frameIndex);
    this.portalWorldsByFrame.delete(frameIndex);

    // Reset frame to empty "+"
    const frameEntity = this.getFrameEntity(frameIndex);
    if (frameEntity) {
      const fg = frameEntity.object3D as THREE.Group;
      const photoCanvas = fg.getObjectByName('photoCanvas') as THREE.Mesh | undefined;
      if (photoCanvas) photoCanvas.visible = true;
      setFrameEmpty(frameEntity);
      fg.userData.currentPhotoUrl = undefined;
      fg.userData.currentPhotoId = undefined;
      fg.userData.currentPhotoName = undefined;
    }
  }

  /** Apply a portal world record from a remote peer (upsert, idempotent). */
  private async applyRemotePortalWorld(record: PortalWorldRecord): Promise<void> {
    // Don't stomp on a locally-initiated generation in progress
    if (this.generatingFrameIndices.has(record.frameIndex)) return;

    this.portalWorldsByFrame.set(record.frameIndex, record);

    const frameEntity = this.getFrameEntity(record.frameIndex);
    if (!frameEntity) return;
    const fg = frameEntity.object3D as THREE.Group;

    // Ensure the photo texture is applied to the frame (idempotent by URL)
    if (fg?.userData.currentPhotoUrl !== record.imageUrl) {
      await setFramePhoto(this.world, frameEntity, record.imageUrl, record.photoId);
      fg.userData.currentPhotoUrl = record.imageUrl;
      fg.userData.currentPhotoId = record.photoId;
      fg.userData.currentPhotoName = record.imageName;
    }

    // Lazily create PortalUI
    const framePositions = generateFramePositions(18);
    const slotPos = framePositions[record.frameIndex];
    if (!this.portalUIHandlesByFrame.has(record.frameIndex)) {
      const slotUI = createPortalUI(
        this.world,
        slotPos.position,
        slotPos.rotation,
        record.imageName,
        'generate',
      );
      if (this.inSplatWorld) slotUI.setVisible(false);
      this.portalUIHandlesByFrame.set(record.frameIndex, slotUI);
    }

    // Sync PortalUI to record state
    const slotUI = this.portalUIHandlesByFrame.get(record.frameIndex)!;
    if (record.state === 'waiting') {
      const remaining = (record.startedAt ?? 0) + (record.estimatedDurationMs ?? 60_000) - Date.now();
      if (remaining > 0) {
        slotUI.startCountdown(remaining);
      } else {
        slotUI.setState('waiting');
      }
    } else if (record.state === 'ready') {
      slotUI.setState('enter');
    }
  }

  /** Remove a portal world record that was deleted by a remote peer. */
  private applyRemotePortalWorldRemoved(frameIndex: number): void {
    this.portalUIHandlesByFrame.get(frameIndex)?.dispose();
    this.portalUIHandlesByFrame.delete(frameIndex);

    this.portalFrameHandlesByFrame.get(frameIndex)?.dispose();
    this.portalFrameHandlesByFrame.delete(frameIndex);

    this.portalWorldsByFrame.delete(frameIndex);

    const frameEntity = this.getFrameEntity(frameIndex);
    if (frameEntity) {
      const fg = frameEntity.object3D as THREE.Group;
      const photoCanvas = fg.getObjectByName('photoCanvas') as THREE.Mesh | undefined;
      if (photoCanvas) photoCanvas.visible = true;
      setFrameEmpty(frameEntity);
      fg.userData.currentPhotoUrl = undefined;
      fg.userData.currentPhotoId = undefined;
      fg.userData.currentPhotoName = undefined;
    }
  }

  /** Update trash button enabled state based on whether any user (local or remote) is in that splat. */
  private updateTrashOccupancy(): void {
    for (const [fIdx, slotUI] of this.portalUIHandlesByFrame) {
      const record = this.portalWorldsByFrame.get(fIdx);
      if (!record) continue;
      const splatCtx = `splat:${record.imageUrl}`;
      const occupied =
        this.currentSplatFrameIndex === fIdx ||
        [...this.multiplayer.getRemoteUsers().values()].some(u => u.context === splatCtx);
      slotUI.setTrashEnabled(!occupied);
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
    // Bail before the XR session is active. XROrigin creates raySpaces.left/right
    // as Groups at construction time, so they exist even outside a session — and
    // their matrixWorld is identity (world position 0,0,0) until a pose arrives.
    // Voice notes loaded synchronously during joinRoom also start with identity
    // matrixWorld until the next render, so without this gate the very first
    // wrapped-update frame would see every voice-note sphere coincident with a
    // (0,0,0) tip and fire onClick on all of them at once.
    if (!this.world.session) {
      this._touchedVoiceSpheres.clear();
      return;
    }

    const spheres = getVoiceNoteSpheres();
    if (spheres.length === 0) {
      this._touchedVoiceSpheres.clear();
      return;
    }

    // Collect tracked tip positions. raySpaces are only valid tips when the
    // corresponding gamepad is defined — IWSDK populates gamepads[handedness]
    // only after an inputsourceschange event with a tracked controller, which
    // guards against the one- or two-frame window where the session is active
    // but the controller pose hasn't been applied yet.
    const tips: THREE.Vector3[] = [];
    const input = this.world.input as any;
    const raySpaces = input.xrOrigin?.raySpaces;
    const gamepads = input.gamepads;
    if (raySpaces?.left && gamepads?.left)
      tips.push(raySpaces.left.getWorldPosition(new THREE.Vector3()));
    if (raySpaces?.right && gamepads?.right)
      tips.push(raySpaces.right.getWorldPosition(new THREE.Vector3()));
    const hands = this.world.input.visualAdapters?.hand;
    if (hands?.left?.connected && hands.left.gripSpace)
      tips.push(hands.left.gripSpace.getWorldPosition(new THREE.Vector3()));
    if (hands?.right?.connected && hands.right.gripSpace)
      tips.push(hands.right.gripSpace.getWorldPosition(new THREE.Vector3()));

    if (tips.length === 0) {
      this._touchedVoiceSpheres.clear();
      return;
    }

    const TOUCH_RADIUS = 0.12; // sphere radius 0.06 + 0.06 tolerance

    for (const sphere of spheres) {
      // getWorldPosition() forces a fresh matrixWorld — protects against the
      // case where a voice note was created via socket between renders and
      // its matrixWorld is still identity.
      const center = sphere.getWorldPosition(new THREE.Vector3());
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

        // Voice recorder stop check (user tapped Stop button on banner)
        if (this.flatVoiceRecorder?.stopRequested) {
          this.flatVoiceRecorder.stopRecording(camera);
          this.flatMode.setMicActive(false);
        }

        // Update drawing camera reference each frame
        if (this.flatDrawing && this.flatMode.isDrawMode) {
          this.flatDrawing.setCamera(camera);
        }

        // Skip look-drag when actively drawing (drawing consumes pointer events)
        if (this.flatDrawing?.isDrawing) {
          // Consume look delta so it doesn't rotate camera while drawing
          flatInput.lookDelta.x = 0;
          flatInput.lookDelta.y = 0;
        }

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
          for (const [, slotUI] of this.portalUIHandlesByFrame) slotUI.updateCountdown();
          this.updateTrashOccupancy();

          // Raycast interaction: reticle → tap anywhere
          this._flatRaycaster.setFromCamera(this._screenCenter, camera);

          // Reticle hover feedback — portal button, slot UIs, plus markers, or voice note spheres
          const buttonMesh = this.portalUI?.getButtonMesh();
          const voiceSpheresFlat = getVoiceNoteSpheres();
          let reticleActive = false;
          if (buttonMesh) {
            reticleActive = this._flatRaycaster.intersectObject(buttonMesh).length > 0;
          }
          if (!reticleActive) {
            for (const [, slotUI] of this.portalUIHandlesByFrame) {
              if (this._flatRaycaster.intersectObject(slotUI.getButtonMesh()).length > 0) {
                reticleActive = true; break;
              }
            }
          }
          if (!reticleActive) {
            for (const fe of this.frameEntities) {
              const pm = (fe.object3D as THREE.Group)?.userData.plusMarker as SlotPlusMarkerHandle | undefined;
              if (pm?.mesh.visible && this._flatRaycaster.intersectObject(pm.mesh).length > 0) {
                reticleActive = true; break;
              }
            }
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

          // Check "+" press + slot PortalUI press on slots 1-17
          for (const frameEntity of this.frameEntities) {
            const fg = frameEntity.object3D as THREE.Group;
            const pm = fg?.userData.plusMarker as SlotPlusMarkerHandle | undefined;
            if (pm?.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed)) {
              const idx = fg?.userData.frameIndex as number;
              this.openPhotoPicker(idx);
            }
            const fIdx = fg?.userData.frameIndex as number;
            const slotUI = this.portalUIHandlesByFrame.get(fIdx);
            if (slotUI) {
              const sp = slotUI.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed);
              if (sp === 'generate') this.startSlotGeneration(fIdx);
              else if (sp === 'enter') this.enterSlotSplat(fIdx);
              if (slotUI.checkTrashRaycastPress(this._flatRaycaster, flatInput.interactPressed)) {
                this.openTrashConfirm(fIdx);
              }
            }
          }
          // PhotoPicker gets its own raycast checks
          this.photoPicker?.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed);

          // Trash confirm dialogs
          for (const [fIdx, dialog] of this.trashDialogsByFrame) {
            const ans = dialog.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed);
            if (ans === 'yes') {
              dialog.dispose();
              this.trashDialogsByFrame.delete(fIdx);
              this.confirmDelete(fIdx);
            } else if (ans === 'no') {
              dialog.dispose();
              this.trashDialogsByFrame.delete(fIdx);
            }
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

          // Adjust panel update + interaction
          this.adjustPanel?.update(camera);
          this._flatRaycaster.setFromCamera(this._screenCenter, camera);
          this.adjustPanel?.checkRaycastPress(this._flatRaycaster, flatInput.interactPressed);

          // Voice note raycast + reticle in splat world (same as museum branch)
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
          for (const [, slotUI] of this.portalUIHandlesByFrame) slotUI.updateCountdown();

          const pressed = this.portalUI?.checkPress(this.world);
          if (pressed === 'generate') {
            this.generateSplatWorld();
          } else if (pressed === 'enter') {
            this.enterSplatWorld();
          }

          // Check "+" press + slot PortalUI press on slots 1-17
          for (const frameEntity of this.frameEntities) {
            const fg = frameEntity.object3D as THREE.Group;
            const pm = fg?.userData.plusMarker as SlotPlusMarkerHandle | undefined;
            if (pm?.checkPress(this.world)) {
              const idx = fg?.userData.frameIndex as number;
              this.openPhotoPicker(idx);
            }
            const fIdx = fg?.userData.frameIndex as number;
            const slotUI = this.portalUIHandlesByFrame.get(fIdx);
            if (slotUI) {
              const sp = slotUI.checkPress(this.world);
              if (sp === 'generate') this.startSlotGeneration(fIdx);
              else if (sp === 'enter') this.enterSlotSplat(fIdx);
              if (slotUI.checkTrashPress(this.world)) this.openTrashConfirm(fIdx);
            }
          }
          // PhotoPicker XR press
          this.photoPicker?.checkPress(this.world);

          // Trash confirm dialogs (XR)
          for (const [fIdx, dialog] of this.trashDialogsByFrame) {
            const ans = dialog.checkPress(this.world);
            if (ans === 'yes') {
              dialog.dispose();
              this.trashDialogsByFrame.delete(fIdx);
              this.confirmDelete(fIdx);
            } else if (ans === 'no') {
              dialog.dispose();
              this.trashDialogsByFrame.delete(fIdx);
            }
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

          // Adjust panel update + XR tip press
          this.adjustPanel?.update(camera);
          this.adjustPanel?.checkPress(this.world);

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