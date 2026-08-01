import { clamp01, lerp } from '../core/MathUtils';

/**
 * Cab instruments, drawn on 2D canvases.
 *
 * Canvas rather than DOM because the needles move every frame and the dial
 * faces want real tick marks, not approximations built from borders.
 */

export interface DialOptions {
  min: number;
  max: number;
  /** Major tick interval in value units. */
  majorStep: number;
  minorPerMajor: number;
  label: string;
  /** Values above this are drawn in the warning colour. */
  redline?: number;
  unit?: string;
  accent?: string;
  size?: number;
}

export class Dial {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private value = 0;
  private displayed = 0;
  private readonly dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(private readonly options: DialOptions) {
    const size = options.size ?? 118;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.drawFace();
  }

  setValue(value: number): void {
    this.value = value;
  }

  /** Smooth the needle and redraw. */
  update(dt: number): void {
    this.displayed = lerp(this.displayed, this.value, 1 - Math.exp(-9 * dt));
    this.drawFace();
  }

  private drawFace(): void {
    const { ctx, options } = this;
    const size = this.canvas.width;
    const r = size / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.translate(r, r);

    const radius = r * 0.88;
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const accent = options.accent ?? '#7fd4ff';

    // Face.
    const grad = ctx.createRadialGradient(0, -radius * 0.3, radius * 0.1, 0, 0, radius);
    grad.addColorStop(0, 'rgba(28,34,42,0.95)');
    grad.addColorStop(1, 'rgba(10,13,17,0.96)');
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.012);
    ctx.strokeStyle = 'rgba(160,190,215,0.35)';
    ctx.stroke();

    // Ticks.
    const range = options.max - options.min;
    const majors = Math.round(range / options.majorStep);
    ctx.lineCap = 'round';
    for (let i = 0; i <= majors * options.minorPerMajor; i++) {
      const value = options.min + (i / (majors * options.minorPerMajor)) * range;
      const angle = start + ((value - options.min) / range) * sweep;
      const major = i % options.minorPerMajor === 0;
      const inner = radius * (major ? 0.7 : 0.79);
      const outer = radius * 0.9;
      const warn = options.redline !== undefined && value >= options.redline;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      ctx.strokeStyle = warn ? 'rgba(255,110,90,0.9)' : major ? 'rgba(226,240,250,0.85)' : 'rgba(150,170,190,0.5)';
      ctx.lineWidth = major ? size * 0.016 : size * 0.008;
      ctx.stroke();

      if (major) {
        ctx.save();
        ctx.fillStyle = 'rgba(210,228,242,0.85)';
        ctx.font = `${Math.round(size * 0.095)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lr = radius * 0.56;
        ctx.fillText(String(Math.round(value)), Math.cos(angle) * lr, Math.sin(angle) * lr);
        ctx.restore();
      }
    }

    // Value arc.
    const t = clamp01((this.displayed - options.min) / range);
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.955, start, start + sweep * t);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = size * 0.03;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Needle.
    const angle = start + sweep * t;
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-radius * 0.14, 0);
    ctx.lineTo(radius * 0.82, -size * 0.014);
    ctx.lineTo(radius * 0.82, size * 0.014);
    ctx.closePath();
    ctx.fillStyle = '#ff5f4d';
    ctx.shadowColor = 'rgba(255,80,60,0.6)';
    ctx.shadowBlur = size * 0.05;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, size * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#dfe9f2';
    ctx.fill();

    // Label.
    ctx.fillStyle = 'rgba(200,220,236,0.8)';
    ctx.font = `${Math.round(size * 0.085)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(options.label, 0, radius * 0.44);
    if (options.unit) {
      ctx.fillStyle = 'rgba(160,185,205,0.75)';
      ctx.font = `${Math.round(size * 0.075)}px "Inter", Arial, sans-serif`;
      ctx.fillText(options.unit, 0, radius * 0.62);
    }
  }
}

export interface RingOptions {
  size?: number;
  thickness?: number;
  accent?: string;
  track?: string;
}

/** A simple progress ring with a large numeral in the middle. */
export class Ring {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dpr = Math.min(window.devicePixelRatio || 1, 2);
  private value = 0;
  private displayed = 0;
  private text = '0';
  private sub = '';

  constructor(private readonly options: RingOptions = {}) {
    const size = options.size ?? 84;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
  }

  set(fraction: number, text: string, sub = ''): void {
    this.value = clamp01(fraction);
    this.text = text;
    this.sub = sub;
  }

  update(dt: number): void {
    this.displayed = lerp(this.displayed, this.value, 1 - Math.exp(-10 * dt));
    const { ctx } = this;
    const size = this.canvas.width;
    const r = size / 2;
    const thickness = (this.options.thickness ?? 7) * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.translate(r, r);

    ctx.beginPath();
    ctx.arc(0, 0, r - thickness, -Math.PI * 0.5, Math.PI * 1.5);
    ctx.strokeStyle = this.options.track ?? 'rgba(140,165,185,0.22)';
    ctx.lineWidth = thickness;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r - thickness, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * this.displayed);
    ctx.strokeStyle = this.options.accent ?? '#63c8ff';
    ctx.lineCap = 'round';
    ctx.lineWidth = thickness;
    ctx.stroke();

    ctx.fillStyle = '#eef6ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(size * 0.32)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(this.text, 0, this.sub ? -size * 0.06 : 0);
    if (this.sub) {
      ctx.fillStyle = 'rgba(190,212,230,0.8)';
      ctx.font = `${Math.round(size * 0.14)}px "Inter", Arial, sans-serif`;
      ctx.fillText(this.sub, 0, size * 0.17);
    }
  }
}
