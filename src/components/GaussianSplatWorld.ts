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

  // Reusable vectors for free-fly
  private _forward = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _thumbstick = new THREE.Vector2();

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

    this.splatMesh.renderOrder = -10;
    this.world.scene.add(this.splatMesh);

    console.log('[SparkJS] SplatMesh added to scene at position:', this.splatMesh.position.toArray());
  }

  update(delta: number): void {
    // Free-fly controls using thumbsticks via IWSDK's StatefulGamepad API
    const leftGamepad = this.world.input.gamepads.left;
    const rightGamepad = this.world.input.gamepads.right;

    if (!leftGamepad && !rightGamepad) return;

    const camera = this.world.camera;
    const player = (this.world as any).player;
    const moveTarget = player?.position || camera.position;

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

    if (moveX === 0 && moveY === 0 && moveVertical === 0) return;

    const speed = this.flySpeed * delta;

    // Move along camera-relative axes
    moveTarget.addScaledVector(this._right, moveX * speed);
    moveTarget.addScaledVector(this._forward, -moveY * speed); // -Y = forward
    moveTarget.y += moveVertical * speed;
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
