// src/components/FlatModeOverlay.ts
// Mobile touch overlay — left joystick, full-screen touch-look, up/down buttons, center reticle, return button.
// Glassmorphism styling via flat-mode.css.

import '../styles/flat-mode.css';

export interface FlatModeInput {
  leftStick: { x: number; y: number };
  lookDelta: { x: number; y: number }; // pixel deltas since last frame, consumed on read
  verticalInput: number;               // -1 (down), 0 (neutral), 1 (up) — from buttons
  interactPressed: boolean;
  returnPressed: boolean;
}

interface JoystickState {
  pointerId: number | null;
  x: number; // -1..1
  y: number; // -1..1
  el: HTMLDivElement;
  knob: HTMLDivElement;
  maxRadius: number; // px, computed from element size
}

export class FlatModeOverlay {
  private container: HTMLDivElement;

  private leftStick: JoystickState;

  private reticleEl: HTMLDivElement;
  private returnBtn: HTMLDivElement;
  private tapZone: HTMLDivElement;

  // Touch-look state
  private lookPointerId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private lookStartX = 0;
  private lookStartY = 0;
  private lookStartTime = 0;
  private lookMoved = false;

  // Up/Down vertical buttons
  private upBtn: HTMLDivElement;
  private downBtn: HTMLDivElement;
  private upPointerId: number | null = null;
  private downPointerId: number | null = null;
  private _verticalInput = 0;

  // One-frame flags (consumed after getInput)
  private _interactPressed = false;
  private _returnPressed = false;

  // Creative toolbar
  private toolbar: HTMLDivElement;
  private drawBtn: HTMLDivElement;
  private micBtn: HTMLDivElement;
  private _drawMode = false;
  private _onDrawToggle: ((active: boolean) => void) | null = null;
  private _onMicToggle: (() => void) | null = null;

  // Desktop keyboard + mouse
  private _keys: Set<string> = new Set();
  private _pointerLocked = false;
  private _inSplatWorld = false;
  private _lockLostOverlay: HTMLDivElement;
  private _isTouchDevice: boolean;

  private entryResolve: (() => void) | null = null;

  constructor(overlayContainer: HTMLElement) {
    this.container = overlayContainer as HTMLDivElement;
    // Hide controls until user enters
    this.container.classList.add('flat-controls-hidden');

    // "Touch-only" = no precision pointer available. Windows hybrids with both a touchscreen and a
    // mouse still have `pointer: fine`, so they get the desktop scheme. Pure phones/tablets don't.
    const hasFinePointer = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: fine)').matches;
    this._isTouchDevice = !hasFinePointer;

    // ── Tap zone (full screen, behind everything) ──
    this.tapZone = this.createDiv('flat-tap-zone');
    this.container.appendChild(this.tapZone);

    // ── Left joystick ──
    const leftEl = this.createDiv('flat-joystick flat-joystick-left');
    const leftKnob = this.createDiv('flat-joystick-knob');
    leftEl.appendChild(leftKnob);
    const leftLabel = this.createDiv('flat-joystick-label');
    leftLabel.textContent = 'Move';
    leftLabel.appendChild(this.makeKeyHint('WASD'));
    leftEl.appendChild(leftLabel);
    this.container.appendChild(leftEl);

    this.leftStick = { pointerId: null, x: 0, y: 0, el: leftEl, knob: leftKnob, maxRadius: 0 };

    // ── Up button ──
    this.upBtn = this.createDiv('flat-vertical-btn flat-vertical-up');
    this.upBtn.textContent = '▲';
    this.upBtn.appendChild(this.makeKeyHint('↑'));
    this.container.appendChild(this.upBtn);

    // ── Down button ──
    this.downBtn = this.createDiv('flat-vertical-btn flat-vertical-down');
    this.downBtn.textContent = '▼';
    this.downBtn.appendChild(this.makeKeyHint('↓'));
    this.container.appendChild(this.downBtn);

    // ── Reticle ──
    this.reticleEl = this.createDiv('flat-reticle');
    const reticleDot = this.createDiv('flat-reticle-dot');
    this.reticleEl.appendChild(reticleDot);
    this.container.appendChild(this.reticleEl);

    // ── Return to Museum button ──
    this.returnBtn = this.createDiv('flat-return-btn');
    this.returnBtn.textContent = 'Return to Museum';
    this.returnBtn.appendChild(this.makeKeyHint('M'));
    this.container.appendChild(this.returnBtn);

    // ── Creative toolbar (mic + draw) — mirrors XR: left hand = voice, right hand = draw ──
    this.toolbar = this.createDiv('flat-toolbar');
    this.micBtn = this.createDiv('flat-toolbar-btn');
    this.micBtn.textContent = '🎤'; // microphone
    this.micBtn.title = 'Voice Note (V)';
    this.micBtn.appendChild(this.makeKeyHint('V'));
    this.toolbar.appendChild(this.micBtn);

    this.drawBtn = this.createDiv('flat-toolbar-btn');
    this.drawBtn.textContent = '✏'; // pencil
    this.drawBtn.title = 'Draw (B)';
    this.drawBtn.appendChild(this.makeKeyHint('B'));
    this.toolbar.appendChild(this.drawBtn);

    this.container.appendChild(this.toolbar);

    // ── Click-to-resume lock overlay (desktop only) ──
    this._lockLostOverlay = this.createDiv('flat-lock-lost-overlay');
    this._lockLostOverlay.textContent = 'Click to resume mouse look (Esc to release)';
    this._lockLostOverlay.addEventListener('click', () => this.requestPointerLock());
    this.container.appendChild(this._lockLostOverlay);

    // ── Event listeners ──
    this.bindJoystick(this.leftStick);
    this.bindTouchLook();
    this.bindVerticalButtons();
    this.bindReturnButton();
    this.bindToolbar();
    this.bindKeyboard();
    this.bindMouseLook();
  }

  // ── Public API ──

  getInput(): FlatModeInput {
    // Merge keyboard WASD with on-screen joystick: prefer keyboard if it's non-zero.
    const kbX = (this._keys.has('KeyD') ? 1 : 0) - (this._keys.has('KeyA') ? 1 : 0);
    const kbY = (this._keys.has('KeyS') ? 1 : 0) - (this._keys.has('KeyW') ? 1 : 0);
    const usingKb = kbX !== 0 || kbY !== 0;
    const stick = usingKb
      ? { x: Math.max(-1, Math.min(1, kbX)), y: Math.max(-1, Math.min(1, kbY)) }
      : { x: this.leftStick.x, y: this.leftStick.y };

    const result: FlatModeInput = {
      leftStick: stick,
      lookDelta: { x: this.lookDeltaX, y: this.lookDeltaY },
      verticalInput: this._verticalInput,
      interactPressed: this._interactPressed,
      returnPressed: this._returnPressed,
    };
    // Consume per-frame accumulators and one-frame flags
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    this._interactPressed = false;
    this._returnPressed = false;
    return result;
  }

  setInSplatWorld(value: boolean): void {
    this._inSplatWorld = value;
    if (!value) {
      // Clear arrow-key vertical state when leaving splat world
      this._keys.delete('ArrowUp');
      this._keys.delete('ArrowDown');
      this.updateVerticalFromKeys();
    }
  }

  setReturnButtonVisible(visible: boolean): void {
    if (visible) {
      this.returnBtn.classList.add('visible');
    } else {
      this.returnBtn.classList.remove('visible');
    }
  }

  setVerticalButtonsVisible(visible: boolean): void {
    if (visible) {
      this.upBtn.classList.add('visible');
      this.downBtn.classList.add('visible');
    } else {
      this.upBtn.classList.remove('visible');
      this.downBtn.classList.remove('visible');
      // Reset held state when hiding
      this._verticalInput = 0;
      this.upPointerId = null;
      this.downPointerId = null;
    }
  }

  setReticleActive(active: boolean): void {
    if (active) {
      this.reticleEl.classList.add('active');
    } else {
      this.reticleEl.classList.remove('active');
    }
  }

  /** Show entry splash screen. Resolves when user taps "Enter". */
  showEntryScreen(): Promise<void> {
    return new Promise((resolve) => {
      this.entryResolve = resolve;

      const splash = this.createDiv('flat-entry-splash');

      const title = this.createDiv('flat-entry-title');
      title.textContent = 'XR Photo Museum';
      splash.appendChild(title);

      const subtitle = this.createDiv('flat-entry-subtitle');
      subtitle.textContent = this._isTouchDevice
        ? 'Drag to look around, use joystick to move, tap to interact'
        : 'Mouse to look, WASD to move, click to interact. Esc releases the mouse.';
      splash.appendChild(subtitle);

      const btn = this.createDiv('flat-entry-btn');
      btn.textContent = 'Enter Experience';
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        splash.remove();
        this.container.classList.remove('flat-controls-hidden');
        // On desktop, the entry click is a user gesture that allows pointer-lock acquisition.
        if (!this._isTouchDevice) this.requestPointerLock();
        if (this.entryResolve) {
          this.entryResolve();
          this.entryResolve = null;
        }
      });
      splash.appendChild(btn);

      this.container.appendChild(splash);
    });
  }

  dispose(): void {
    this._keys.clear();
    if (this._pointerLocked) {
      try { document.exitPointerLock(); } catch { /* noop */ }
    }
    this.container.innerHTML = '';
  }

  // ── Joystick binding ──

  private bindJoystick(stick: JoystickState): void {
    const el = stick.el;

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (stick.pointerId !== null) return; // already tracking a finger
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      stick.pointerId = e.pointerId;
      stick.knob.classList.add('active');

      // Compute max radius (half the element size minus knob half)
      const rect = el.getBoundingClientRect();
      stick.maxRadius = rect.width * 0.3; // 30% of pad for comfortable range
    });

    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== stick.pointerId) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      let dx = e.clientX - centerX;
      let dy = e.clientY - centerY;

      // Clamp to max radius
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = stick.maxRadius || rect.width * 0.3;
      if (dist > maxR) {
        dx = (dx / dist) * maxR;
        dy = (dy / dist) * maxR;
      }

      // Normalize to -1..1
      stick.x = dx / maxR;
      stick.y = dy / maxR;

      // Move knob visually
      stick.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    });

    const resetStick = (e: PointerEvent) => {
      if (e.pointerId !== stick.pointerId) return;
      stick.pointerId = null;
      stick.x = 0;
      stick.y = 0;
      stick.knob.classList.remove('active');
      stick.knob.style.transform = 'translate(-50%, -50%)';
    };

    el.addEventListener('pointerup', resetStick);
    el.addEventListener('pointercancel', resetStick);
  }

  // ── Touch-look (replaces right joystick + old tap zone) ──

  private bindTouchLook(): void {
    this.tapZone.addEventListener('pointerdown', (e: PointerEvent) => {
      // Desktop mouse is handled by the pointer-lock path in bindMouseLook(); keep this for touch/pen only.
      if (e.pointerType === 'mouse') return;
      const target = e.target as HTMLElement;
      if (target !== this.tapZone) return; // only respond to direct tap zone hits
      if (this.lookPointerId !== null) return; // already tracking a look touch

      e.preventDefault();
      this.tapZone.setPointerCapture(e.pointerId);
      this.lookPointerId = e.pointerId;
      this.lookLastX = e.clientX;
      this.lookLastY = e.clientY;
      this.lookStartX = e.clientX;
      this.lookStartY = e.clientY;
      this.lookStartTime = performance.now();
      this.lookMoved = false;
    });

    this.tapZone.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.lookPointerId) return;
      e.preventDefault();

      const dx = e.clientX - this.lookLastX;
      const dy = e.clientY - this.lookLastY;
      this.lookDeltaX += dx;
      this.lookDeltaY += dy;
      this.lookLastX = e.clientX;
      this.lookLastY = e.clientY;

      // Mark as drag if moved more than 8px from start
      if (!this.lookMoved) {
        const totalDx = e.clientX - this.lookStartX;
        const totalDy = e.clientY - this.lookStartY;
        if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 8) {
          this.lookMoved = true;
        }
      }
    });

    const endLook = (e: PointerEvent, isCancelled: boolean) => {
      if (e.pointerId !== this.lookPointerId) return;

      // Tap: short press without significant movement = interact
      if (!isCancelled && !this.lookMoved && (performance.now() - this.lookStartTime) < 300) {
        this._interactPressed = true;
      }

      this.lookPointerId = null;
      this.lookDeltaX = 0;
      this.lookDeltaY = 0;
    };

    this.tapZone.addEventListener('pointerup', (e: PointerEvent) => endLook(e, false));
    this.tapZone.addEventListener('pointercancel', (e: PointerEvent) => endLook(e, true));
  }

  // ── Up/Down vertical movement buttons ──

  private bindVerticalButtons(): void {
    const bindBtn = (
      btn: HTMLDivElement,
      value: number,
      getPointerId: () => number | null,
      setPointerId: (id: number | null) => void,
    ) => {
      btn.addEventListener('pointerdown', (e: PointerEvent) => {
        if (getPointerId() !== null) return;
        e.preventDefault();
        e.stopPropagation();
        btn.setPointerCapture(e.pointerId);
        setPointerId(e.pointerId);
        this._verticalInput = value;
        btn.classList.add('pressed');
      });

      const release = (e: PointerEvent) => {
        if (e.pointerId !== getPointerId()) return;
        setPointerId(null);
        btn.classList.remove('pressed');
        // Only clear vertical input if this button was driving it
        if (this._verticalInput === value) {
          this._verticalInput = 0;
        }
      };

      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
    };

    bindBtn(
      this.upBtn, 1,
      () => this.upPointerId,
      (id) => { this.upPointerId = id; },
    );
    bindBtn(
      this.downBtn, -1,
      () => this.downPointerId,
      (id) => { this.downPointerId = id; },
    );
  }

  // ── Return button ──

  private bindReturnButton(): void {
    this.returnBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._returnPressed = true;
    });
  }

  // ── Toolbar ──

  private bindToolbar(): void {
    this.drawBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleDrawMode();
    });

    this.micBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMicMode();
    });
  }

  private toggleDrawMode(): void {
    this._drawMode = !this._drawMode;
    this.drawBtn.classList.toggle('active', this._drawMode);
    this._onDrawToggle?.(this._drawMode);

    // Desktop: free the cursor while drawing so the user can move the mouse to draw,
    // then re-lock to the crosshair when they exit draw mode.
    if (!this._isTouchDevice) {
      if (this._drawMode) {
        if (this._pointerLocked) {
          try { document.exitPointerLock(); } catch { /* noop */ }
        }
      } else if (!this.container.classList.contains('flat-controls-hidden')) {
        this.requestPointerLock();
      }
    }
  }

  private toggleMicMode(): void {
    this._onMicToggle?.();
  }

  // ── Desktop keyboard ──

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    window.addEventListener('keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      // Release any held keys when window loses focus so user doesn't get stuck moving
      this._keys.clear();
      this.updateVerticalFromKeys();
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (this.container.classList.contains('flat-controls-hidden')) return;

    switch (e.code) {
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
        this._keys.add(e.code);
        break;
      case 'ArrowUp': case 'ArrowDown':
        if (!this._inSplatWorld) return;
        e.preventDefault();
        this._keys.add(e.code);
        this.updateVerticalFromKeys();
        break;
      case 'KeyM':
        if (!e.repeat && this._inSplatWorld) this._returnPressed = true;
        break;
      case 'KeyV':
        if (!e.repeat) this.toggleMicMode();
        break;
      case 'KeyB':
        if (!e.repeat) this.toggleDrawMode();
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    switch (e.code) {
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
        this._keys.delete(e.code);
        break;
      case 'ArrowUp': case 'ArrowDown':
        this._keys.delete(e.code);
        this.updateVerticalFromKeys();
        break;
    }
  }

  private updateVerticalFromKeys(): void {
    // Only honor arrow keys when in splat world; otherwise leave pointer-event-driven state alone
    if (!this._inSplatWorld) return;
    const up = this._keys.has('ArrowUp');
    const down = this._keys.has('ArrowDown');
    if (up && !down) this._verticalInput = 1;
    else if (down && !up) this._verticalInput = -1;
    else if (!up && !down && this.upPointerId === null && this.downPointerId === null) {
      this._verticalInput = 0;
    }
  }

  // ── Desktop mouse look + pointer lock ──

  private bindMouseLook(): void {
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange());

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this._pointerLocked) return;
      this.lookDeltaX += e.movementX;
      this.lookDeltaY += e.movementY;
    });

    // Left mouse on the tap zone:
    //   - If not yet locked, acquire pointer lock (don't fire interact — that click was for locking).
    //   - If locked, count as an interact press for the center-crosshair raycast.
    this.tapZone.addEventListener('mousedown', (e: MouseEvent) => {
      if (this._isTouchDevice || e.button !== 0) return;
      if (this.container.classList.contains('flat-controls-hidden')) return;
      // While drawing the cursor is intentionally free so the user can sketch — let the
      // drawing canvas receive the click instead of grabbing pointer lock.
      if (this._drawMode) return;
      if (!this._pointerLocked) {
        e.preventDefault();
        e.stopPropagation();
        this.requestPointerLock();
      } else {
        this._interactPressed = true;
      }
    });
  }

  private requestPointerLock(): void {
    if (this._isTouchDevice) return;
    try {
      this.tapZone.requestPointerLock();
    } catch {
      // ignore — overlay click-to-resume handles recovery
    }
  }

  private onPointerLockChange(): void {
    this._pointerLocked = document.pointerLockElement === this.tapZone;
    if (this._pointerLocked) {
      this._lockLostOverlay.classList.remove('visible');
    } else if (
      !this.container.classList.contains('flat-controls-hidden')
      && !this._isTouchDevice
      && !this._drawMode
    ) {
      this._lockLostOverlay.classList.add('visible');
    } else {
      this._lockLostOverlay.classList.remove('visible');
    }
  }

  private makeKeyHint(label: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'flat-key-hint';
    span.textContent = label;
    return span;
  }

  setOnDrawToggle(cb: (active: boolean) => void): void {
    this._onDrawToggle = cb;
  }

  setOnMicToggle(cb: () => void): void {
    this._onMicToggle = cb;
  }

  get isDrawMode(): boolean {
    return this._drawMode;
  }

  setDrawActive(active: boolean): void {
    this._drawMode = active;
    this.drawBtn.classList.toggle('active', active);
  }

  setMicActive(active: boolean): void {
    this.micBtn.classList.toggle('active', active);
  }

  // ── Helpers ──

  private createDiv(className: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = className;
    return div;
  }
}
