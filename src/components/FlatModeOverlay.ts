// src/components/FlatModeOverlay.ts
// Mobile touch overlay — dual joysticks, center reticle, return button.
// Glassmorphism styling via flat-mode.css.

import '../styles/flat-mode.css';

export interface FlatModeInput {
  leftStick: { x: number; y: number };
  rightStick: { x: number; y: number };
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
  private rightStick: JoystickState;

  private reticleEl: HTMLDivElement;
  private returnBtn: HTMLDivElement;
  private tapZone: HTMLDivElement;

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

    // ── Right joystick ──
    const rightEl = this.createDiv('flat-joystick flat-joystick-right');
    const rightKnob = this.createDiv('flat-joystick-knob');
    rightEl.appendChild(rightKnob);
    const rightLabel = this.createDiv('flat-joystick-label');
    rightLabel.textContent = 'Look';
    rightEl.appendChild(rightLabel);
    this.container.appendChild(rightEl);

    this.rightStick = { pointerId: null, x: 0, y: 0, el: rightEl, knob: rightKnob, maxRadius: 0 };

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
    this.bindJoystick(this.rightStick);
    this.bindTapZone();
    this.bindReturnButton();
  }

  // ── Public API ──

  getInput(): FlatModeInput {
    const result: FlatModeInput = {
      leftStick: { x: this.leftStick.x, y: this.leftStick.y },
      rightStick: { x: this.rightStick.x, y: this.rightStick.y },
      interactPressed: this._interactPressed,
      returnPressed: this._returnPressed,
    };
    // Consume one-frame flags
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
      subtitle.textContent = 'Use the joysticks to explore the museum and tap to interact';
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

  // ── Tap zone (interact) ──

  private bindTapZone(): void {
    this.tapZone.addEventListener('pointerdown', (e: PointerEvent) => {
      // Only count as interact if not on a joystick or button
      const target = e.target as HTMLElement;
      if (target === this.tapZone) {
        e.preventDefault();
        this._interactPressed = true;
      }
    });
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
