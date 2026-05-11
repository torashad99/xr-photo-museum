import * as THREE from 'three';
import { World } from '@iwsdk/core';
import { startStroke, addPointToStroke } from './Drawing';
import { MultiplayerService } from '../services/MultiplayerService';

const DRAW_PLANE_DISTANCE = 1.5;
const MIN_POINT_DISTANCE = 0.01;

export class FlatModeDrawing {
  private world: World;
  private multiplayer: MultiplayerService;
  private tapZone: HTMLElement;

  private active = false;
  private drawing = false;
  private activeLine: THREE.Line | null = null;
  private activeLinePoints: THREE.Vector3[] = [];
  private lastDrawPoint = new THREE.Vector3();

  private camera: THREE.Camera | null = null;
  private plane = new THREE.Plane();
  private raycaster = new THREE.Raycaster();

  private context = 'museum';

  // Bound handlers for cleanup
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp: (e: PointerEvent) => void;

  constructor(world: World, multiplayer: MultiplayerService, tapZone: HTMLElement) {
    this.world = world;
    this.multiplayer = multiplayer;
    this.tapZone = tapZone;

    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp = this.handlePointerUp.bind(this);
  }

  setContext(ctx: string): void {
    this.context = ctx;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.tapZone.addEventListener('pointerdown', this._onPointerDown);
    this.tapZone.addEventListener('pointermove', this._onPointerMove);
    this.tapZone.addEventListener('pointerup', this._onPointerUp);
    this.tapZone.addEventListener('pointercancel', this._onPointerUp);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.finishStroke();
    this.tapZone.removeEventListener('pointerdown', this._onPointerDown);
    this.tapZone.removeEventListener('pointermove', this._onPointerMove);
    this.tapZone.removeEventListener('pointerup', this._onPointerUp);
    this.tapZone.removeEventListener('pointercancel', this._onPointerUp);
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.camera) return;
    e.preventDefault();
    e.stopPropagation();

    this.drawing = true;
    this.updatePlane();

    const point = this.screenToPlane(e.clientX, e.clientY);
    if (!point) { this.drawing = false; return; }

    const result = startStroke(this.world, 'black', point, this.context);
    this.activeLine = result.line;
    this.activeLinePoints = result.points;
    this.lastDrawPoint.copy(point);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.drawing || !this.activeLine || !this.camera) return;
    e.preventDefault();
    e.stopPropagation();

    const point = this.screenToPlane(e.clientX, e.clientY);
    if (!point) return;

    if (point.distanceTo(this.lastDrawPoint) > MIN_POINT_DISTANCE) {
      addPointToStroke(this.activeLine, point, this.activeLinePoints);
      this.lastDrawPoint.copy(point);
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.drawing) return;
    e.preventDefault();
    e.stopPropagation();
    this.finishStroke();
  }

  private finishStroke(): void {
    if (this.activeLine && this.activeLinePoints.length > 1) {
      this.multiplayer.emitStroke(this.activeLinePoints, 'black', this.context);
    }
    this.activeLine = null;
    this.activeLinePoints = [];
    this.drawing = false;
  }

  private updatePlane(): void {
    if (!this.camera) return;
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    this.camera.getWorldPosition(worldPos);
    this.camera.getWorldQuaternion(worldQuat);
    const normal = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuat);
    const planePoint = worldPos.add(normal.clone().multiplyScalar(DRAW_PLANE_DISTANCE));
    this.plane.setFromNormalAndCoplanarPoint(normal.negate(), planePoint);
  }

  private screenToPlane(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.camera) return null;
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const target = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.plane, target);
    return hit;
  }
}
