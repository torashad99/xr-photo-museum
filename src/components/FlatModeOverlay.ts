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

  private entryResolve: (() => void) | null = null;

  constructor(overlayContainer: HTMLElement) {
    this.container = overlayContainer as HTMLDivElement;
    // Hide controls until user enters
    this.container.classList.add('flat-controls-hidden');

    // ── Tap zone (full screen, behind everything) ──
    this.tapZone = this.createDiv('flat-tap-zone');
    this.container.appendChild(this.tapZone);

    // ── Left joystick ──
    const leftEl = this.createDiv('flat-joystick flat-joystick-left');
    const leftKnob = this.createDiv('flat-joystick-knob');
    leftEl.appendChild(leftKnob);
    const leftLabel = this.createDiv('flat-joystick-label');
    leftLabel.textContent = 'Move';
    leftEl.appendChild(leftLabel);
    this.container.appendChild(leftEl);

    this.leftStick = { pointerId: null, x: 0, y: 0, el: leftEl, knob: leftKnob, maxRadius: 0 };

    // ── Up button ──
    this.upBtn = this.createDiv('flat-vertical-btn flat-vertical-up');
    this.upBtn.textContent = '▲';
    this.container.appendChild(this.upBtn);

    // ── Down button ──
    this.downBtn = this.createDiv('flat-vertical-btn flat-vertical-down');
    this.downBtn.textContent = '▼';
    this.container.appendChild(this.downBtn);

    // ── Reticle ──
    this.reticleEl = this.createDiv('flat-reticle');
    const reticleDot = this.createDiv('flat-reticle-dot');
    this.reticleEl.appendChild(reticleDot);
    this.container.appendChild(this.reticleEl);

    // ── Return to Museum button ──
    this.returnBtn = this.createDiv('flat-return-btn');
    this.returnBtn.textContent = 'Return to Museum';
    this.container.appendChild(this.returnBtn);

    // ── Event listeners ──
    this.bindJoystick(this.leftStick);
    this.bindTouchLook();
    this.bindVerticalButtons();
    this.bindReturnButton();
  }

  // ── Public API ──

  getInput(): FlatModeInput {
    const result: FlatModeInput = {
      leftStick: { x: this.leftStick.x, y: this.leftStick.y },
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
      subtitle.textContent = 'Drag to look around, use joystick to move, tap to interact';
      splash.appendChild(subtitle);

      const btn = this.createDiv('flat-entry-btn');
      btn.textContent = 'Enter Experience';
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        splash.remove();
        this.container.classList.remove('flat-controls-hidden');
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

  // ── Helpers ──

  private createDiv(className: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = className;
    return div;
  }
}
