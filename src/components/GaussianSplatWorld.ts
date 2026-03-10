// src/components/GaussianSplatWorld.ts
import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { InputComponent } from '@iwsdk/xr-input';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const LOAD_TIMEOUT_MS = 30_000;

export class GaussianSplatWorld {
  private world: World;
  private sparkRenderer: SparkRenderer | null = null;
  private splatMesh: SplatMesh | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private savedBackground: THREE.Color | THREE.Texture | null = null;
  private flySpeed = 2.0;

  // Own position state for free-fly (written to player.position each frame
  // AFTER IWSDK's LocomotionSystem overwrites it from its internal locomotor)
  private flyPosition = new THREE.Vector3(0, 1.6, 0);

  // Reusable vectors for free-fly
  private _forward = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _thumbstick = new THREE.Vector2();

  // Dual-grip zoom state (Open Brush style)
  private currentScale = 1.5;
  private isGrabbing = false;
  private grabStartDistance = 0;
  private grabStartScale = 0;
  private grabStartSplatPos = new THREE.Vector3();
  private grabStartPlayerPos = new THREE.Vector3();
  private readonly MIN_SCALE = 0.3;
  private readonly MAX_SCALE = 15.0;
  private _leftPos = new THREE.Vector3();
  private _rightPos = new THREE.Vector3();
  private _pivotOffset = new THREE.Vector3();

  constructor(world: World) {
    this.world = world;
  }

  async loadSplat(spzUrl: string): Promise<void> {
    console.log('[SparkJS] Initializing SparkRenderer...');

    // Save and set scene background to black (splats are self-illuminated)
    this.savedBackground = this.world.scene.background as any;
    this.world.scene.background = new THREE.Color(0x000000);

    // Add ambient light (museum light is hidden with room group)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    this.world.scene.add(this.ambientLight);

    // Initialize SparkRenderer with the IWSDK's WebGL renderer
    const spark = new SparkRenderer({
      renderer: this.world.renderer,
      enableLod: true,
      lodSplatScale: 1.0,
      behindFoveate: 0.1,
    });
    spark.outsideFoveate = 0.3;
    spark.renderOrder = -10;
    this.world.scene.add(spark);
    this.sparkRenderer = spark;

    console.log('[SparkJS] SparkRenderer added to scene');

    // Patch camera.clone() — SparkJS driveLod() deep-clones the camera
    // every frame. IWSDK's camera has UIKitDocument children that crash
    // during clone, so we return a plain PerspectiveCamera with only the
    // transform/projection data SparkJS needs for LoD calculations.
    const cam = this.world.camera as THREE.PerspectiveCamera;
    cam.clone = function () {
      const c = new THREE.PerspectiveCamera();
      c.projectionMatrix.copy(this.projectionMatrix);
      c.projectionMatrixInverse.copy(this.projectionMatrixInverse);
      c.matrixWorld.copy(this.matrixWorld);
      c.matrixWorldInverse.copy(this.matrixWorldInverse);
      return c;
    };

    // Configure for Quest 3 VR performance
    (SparkRenderer as any).maxStdDev = Math.sqrt(5);

    console.log('[SparkJS] Loading splat from:', spzUrl);

    // Load the splat
    this.splatMesh = new SplatMesh({
      url: spzUrl,
      lod: true,
    });

    // Wait for load with timeout
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out loading splat "${spzUrl}" after ${LOAD_TIMEOUT_MS / 1000}s`)),
        LOAD_TIMEOUT_MS,
      );
    });
    await Promise.race([this.splatMesh.initialized, timeout]);

    console.log('[SparkJS] SplatMesh initialized, splatCount:', (this.splatMesh as any).splatCount ?? 'unknown');

    // Fix orientation (World Labs splats come upside down) and scale up
    this.splatMesh.rotation.x = Math.PI;
    this.splatMesh.scale.setScalar(1.5);

    this.splatMesh.renderOrder = -10;
    this.world.scene.add(this.splatMesh);

    // Compute world-space bounding box of the loaded splat to determine
    // a good initial viewing position (instead of hardcoded origin).
    this.splatMesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.splatMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    if (box.isEmpty() || size.length() < 0.01) {
      // Fallback: splat has no computable bounds (SparkJS SplatMesh may not
      // expose geometry). Place player at scene origin with a small offset.
      this.flyPosition.set(0, 1.6, 2);
      console.log('[SparkJS] Bounding box empty, using fallback position');
    } else {
      const radius = size.length() / 2;
      const pullback = Math.max(radius * 0.5, 1.0);
      this.flyPosition.set(center.x, center.y, center.z + pullback);
      console.log(`[SparkJS] Splat bounds center: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}), radius: ${radius.toFixed(2)}, pullback: ${pullback.toFixed(2)}`);
    }

    console.log('[SparkJS] SplatMesh added to scene, rotated 180° on X, scaled 1.5x');
  }

  update(delta: number): void {
    const camera = this.world.camera;
    const player = (this.world as any).player;

    // Read thumbstick input for free-fly
    const leftGamepad = this.world.input.gamepads.left;
    const rightGamepad = this.world.input.gamepads.right;

    if (leftGamepad || rightGamepad) {
      // Get camera forward (projected onto XZ for horizontal movement)
      camera.getWorldDirection(this._forward);
      this._forward.y = 0;
      this._forward.normalize();

      // Right vector
      this._right.crossVectors(this._forward, this._up).normalize();

      let moveX = 0;
      let moveY = 0;
      let moveVertical = 0;

      // Left thumbstick: forward/back (Y) + strafe (X)
      if (leftGamepad) {
        const axes = leftGamepad.getAxesValues(InputComponent.Thumbstick);
        if (axes) {
          this._thumbstick.copy(axes);
          moveX = this._thumbstick.x;
          moveY = this._thumbstick.y;
        }
      }

      // Right thumbstick Y: up/down
      if (rightGamepad) {
        const axes = rightGamepad.getAxesValues(InputComponent.Thumbstick);
        if (axes) {
          moveVertical = -axes.y; // Invert: push up = go up
        }
      }

      // Apply dead zone
      const deadZone = 0.15;
      if (Math.abs(moveX) < deadZone) moveX = 0;
      if (Math.abs(moveY) < deadZone) moveY = 0;
      if (Math.abs(moveVertical) < deadZone) moveVertical = 0;

      if (moveX !== 0 || moveY !== 0 || moveVertical !== 0) {
        const speed = this.flySpeed * delta;
        this.flyPosition.addScaledVector(this._right, moveX * speed);
        this.flyPosition.addScaledVector(this._forward, -moveY * speed);
        this.flyPosition.y += moveVertical * speed;
      }
    }

    // Dual-trigger zoom: hold both triggers, move controllers
    // apart to zoom in (scale up splat), together to zoom out.
    if (leftGamepad && rightGamepad && this.splatMesh) {
      const leftGripBtn = leftGamepad.getButtonPressed(InputComponent.Squeeze);
      const rightGripBtn = rightGamepad.getButtonPressed(InputComponent.Squeeze);

      if (leftGripBtn && rightGripBtn) {
        // Get controller world positions from xrOrigin grip spaces
        // (updated each frame from XRFrame.getPose in the input manager)
        const xrOrigin = (this.world.input as any).xrOrigin;
        const leftGrip = xrOrigin?.gripSpaces?.left;
        const rightGrip = xrOrigin?.gripSpaces?.right;

        if (leftGrip && rightGrip) {
          leftGrip.getWorldPosition(this._leftPos);
          rightGrip.getWorldPosition(this._rightPos);
          const dist = this._leftPos.distanceTo(this._rightPos);

          if (!this.isGrabbing) {
            this.isGrabbing = true;
            this.grabStartDistance = dist;
            this.grabStartScale = this.currentScale;
            this.grabStartSplatPos.copy(this.splatMesh.position);
            this.grabStartPlayerPos.copy(this.flyPosition);
            console.log(`[Zoom] Grab started, dist: ${dist.toFixed(3)}, scale: ${this.currentScale.toFixed(2)}`);
          } else if (this.grabStartDistance > 0.05) {
            const ratio = dist / this.grabStartDistance;
            const newScale = THREE.MathUtils.clamp(
              this.grabStartScale * ratio,
              this.MIN_SCALE,
              this.MAX_SCALE,
            );

            // Scale splat around the player position as pivot
            const scaleFactor = newScale / this.grabStartScale;
            this._pivotOffset.subVectors(this.grabStartSplatPos, this.grabStartPlayerPos);
            this.splatMesh.position.copy(this.flyPosition).addScaledVector(this._pivotOffset, scaleFactor);
            this.splatMesh.scale.setScalar(newScale);
            this.currentScale = newScale;
          }
        }
      } else {
        this.isGrabbing = false;
      }
    } else {
      this.isGrabbing = false;
    }

    // Force our fly position onto the player every frame.
    // This runs AFTER IWSDK's LocomotionSystem.update() which overwrites
    // player.position from its internal locomotor. We overwrite it right back.
    if (player?.position) {
      player.position.copy(this.flyPosition);
    }
  }

  /** Check if left controller Y button was just pressed (return to gallery). */
  checkMenuPress(): boolean {
    const leftGamepad = this.world.input.gamepads.left;
    if (!leftGamepad) return false;
    return leftGamepad.getButtonDown(InputComponent.Y_Button);
  }

  dispose(): void {
    if (this.splatMesh) {
      this.world.scene.remove(this.splatMesh);
      this.splatMesh.dispose();
      this.splatMesh = null;
    }
    if (this.sparkRenderer) {
      this.world.scene.remove(this.sparkRenderer);
      this.sparkRenderer = null;
    }
    if (this.ambientLight) {
      this.world.scene.remove(this.ambientLight);
      this.ambientLight = null;
    }
    // Restore scene background
    if (this.savedBackground !== null) {
      this.world.scene.background = this.savedBackground;
      this.savedBackground = null;
    }
  }
}
