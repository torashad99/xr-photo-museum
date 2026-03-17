// src/index.ts
import { World, Entity } from '@iwsdk/core';
import { XRInputVisualAdapter, AnimatedController, InputComponent } from '@iwsdk/xr-input';
import * as THREE from 'three';
import { createMuseumRoom } from './components/MuseumRoom';
import { createPhotoFrame, generateFramePositions, setFramePhoto } from './components/PhotoFrame';
import { createAnnotation, updateAnnotationFacing, hideAllAnnotations, showAllAnnotations } from './components/Annotation';
import { createVoiceNote, updateVoiceNoteFacing, hideAllVoiceNotes, showAllVoiceNotes, getVoiceNoteSpheres } from './components/VoiceNote';
import { GoogleAuthService } from './services/googleAuth';
import { GooglePhotosService, MediaItem } from './services/photosService'
import { MultiplayerService, RemoteUser } from './services/MultiplayerService';
import { CreativeInputSystem } from './components/CreativeInputSystem';
import { startStroke, addPointToStroke, hideAllDrawings, showAllDrawings } from './components/Drawing';
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
  private creativeInput: CreativeInputSystem | null = null;
  private inSplatWorld: boolean = false;

  // Portal / Splat world
  private portalFrame: PortalFrameHandle | null = null;
  private portalUI: PortalUIHandle | null = null;
  private gaussianSplatWorld: GaussianSplatWorld | null = null;
  private worldLabsService: WorldLabsService = new WorldLabsService();
  private cachedSplatResult: SplatResult | null = null;

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

  // XR controller raycaster for voice note interaction
  private _xrRaycaster = new THREE.Raycaster();
  private _xrRayDir = new THREE.Vector3();
  private _xrRayOrigin = new THREE.Vector3();

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
      await this.multiplayer.joinRoom(roomId, username);
    } else {
      const { inviteLink } = await this.multiplayer.createRoom(username);
      console.log('Share this invite link:', inviteLink);
      // Show invite link in UI
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

      // Hide all museum drawings, annotations, and voice notes
      hideAllAnnotations();
      hideAllVoiceNotes();
      hideAllDrawings();

      // Load splat
      this.gaussianSplatWorld = new GaussianSplatWorld(this.world);
      await this.gaussianSplatWorld.loadSplat(result.spzUrl);

      console.log('[SplatWorld] Splat loaded successfully');

      // Position player at splat origin via locomotor.teleport()
      const locomotor = this.getLocomotor();
      if (locomotor) {
        locomotor.teleport(new THREE.Vector3(0, 1.6, 0));
      }

      this.inSplatWorld = true;

      // Show "Return to Museum" button and vertical buttons in flat mode
      this.flatMode?.setReturnButtonVisible(true);
      this.flatMode?.setVerticalButtonsVisible(true);

    } catch (err) {
      console.error('[SplatWorld] Failed to enter splat world:', err);
    }
  }

  private exitSplatWorld(): void {
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

    // Restore museum drawings, annotations, and voice notes
    showAllAnnotations();
    showAllVoiceNotes();
    showAllDrawings();

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
   * Cast a ray from the right controller and toggle playback on any voice note
   * sphere hit when the right A button is pressed.
   * Called each frame only while in the gallery (not the splat world).
   */
  private handleVoiceNoteXRInteraction(): void {
    const rightGamepad = this.world.input.gamepads.right;
    if (!rightGamepad?.getButtonDown(InputComponent.A_Button)) return;

    const spheres = getVoiceNoteSpheres();
    if (spheres.length === 0) return;

    const raySpace = (this.world.input as any).xrOrigin?.raySpaces?.right;
    if (!raySpace) return;

    this._xrRayOrigin.setFromMatrixPosition(raySpace.matrixWorld);
    this._xrRayDir.set(0, 0, -1).applyQuaternion(
      new THREE.Quaternion().setFromRotationMatrix(raySpace.matrixWorld),
    );
    this._xrRaycaster.set(this._xrRayOrigin, this._xrRayDir);

    const hits = this._xrRaycaster.intersectObjects(spheres);
    if (hits.length > 0) {
      hits[0].object.userData.onClick?.();
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
          this.multiplayer.updatePosition(camera.position, camera.quaternion);
          updateAnnotationFacing(camera);
          updateVoiceNoteFacing(camera);
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
          this.gaussianSplatWorld?.update(delta);
        }
      } else {
        // ── XR mode (original behavior) ──
        if (!this.inSplatWorld) {
          this.multiplayer.updatePosition(camera.position, camera.quaternion);
          this.creativeInput?.update(delta, time);
          updateAnnotationFacing(camera);
          updateVoiceNoteFacing(camera);
          this.portalFrame?.updateParallax(camera);
          this.portalUI?.updateCountdown();

          const pressed = this.portalUI?.checkPress(this.world);
          if (pressed === 'generate') {
            this.generateSplatWorld();
          } else if (pressed === 'enter') {
            this.enterSplatWorld();
          }

          // Voice note playback: right A button + right controller raycast
          this.handleVoiceNoteXRInteraction();
        } else {
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