/**
 * Keyboard and pointer input.
 *
 * Held state is polled by the simulation; edge-triggered presses are consumed
 * once per frame so a single key tap moves exactly one notch.
 */

export class Input {
  private readonly down = new Set<string>();
  /**
   * Presses are counted rather than flagged: on a slow frame several taps of
   * the same key can arrive between two updates, and every one of them should
   * move a notch.
   */
  private readonly pressed = new Map<string, number>();
  private readonly released = new Set<string>();

  /** Accumulated look delta in radians, consumed each frame by the camera. */
  lookYaw = 0;
  lookPitch = 0;
  /** Mouse wheel delta accumulated since the last frame. */
  wheel = 0;

  private dragging = false;
  private readonly sensitivity = 0.0022;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // Keys the browser would otherwise scroll or search with.
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'Tab',
        'Slash',
        'Backquote',
        'Quote',
        'BracketLeft',
        'Enter',
        'Comma',
        'Period',
      ].includes(e.code)
    ) {
      e.preventDefault();
    }
    if (!e.repeat) {
      this.pressed.set(e.code, (this.pressed.get(e.code) ?? 0) + 1);
      this.down.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.released.add(e.code);
  };

  private onBlur = (): void => {
    this.down.clear();
    this.dragging = false;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.target !== this.element) return;
    this.dragging = true;
    this.element.setPointerCapture?.(e.pointerId);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private onPointerMove = (e: PointerEvent): void => {
    const locked = document.pointerLockElement === this.element;
    if (!locked && !this.dragging) return;
    this.lookYaw -= e.movementX * this.sensitivity;
    this.lookPitch -= e.movementY * this.sensitivity;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /**
   * True if the key went down since the last call, consuming one press so that
   * a burst of taps is delivered one at a time.
   */
  wasPressed(code: string): boolean {
    const count = this.pressed.get(code) ?? 0;
    if (count <= 0) return false;
    if (count === 1) this.pressed.delete(code);
    else this.pressed.set(code, count - 1);
    return true;
  }

  /** True if the key went down, without consuming the press. */
  isPressed(code: string): boolean {
    return (this.pressed.get(code) ?? 0) > 0;
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  anyPressed(): boolean {
    return this.pressed.size > 0;
  }

  /** Clears per-frame state. Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.wheel = 0;
  }
}
