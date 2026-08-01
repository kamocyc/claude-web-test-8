/** Small numeric helpers shared across simulation and rendering. */

export const KMH = 1 / 3.6; // km/h -> m/s
export const MS_TO_KMH = 3.6;
export const GRAVITY = 9.80665;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Frame-rate independent exponential approach ("damp towards target"). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Formats seconds since midnight as HH:MM:SS. */
export function formatClock(secondsOfDay: number): string {
  const t = ((secondsOfDay % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

export function formatClockShort(secondsOfDay: number): string {
  const t = ((secondsOfDay % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}`;
}

/** Formats a signed delay as +0:03s / -0:12s, matching cab display convention. */
export function formatDelta(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const t = Math.abs(seconds);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${sign}${m}:${pad2(s)}s`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${Math.floor(n)}` : `${Math.floor(n)}`;
}

/** Distance formatted the way a Japanese cab display shows it (m below 1 km). */
export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.max(0, Math.round(meters / 10) * 10)}m`;
}

/** Kilometre post notation, e.g. K83+650. */
export function formatMilepost(meters: number): string {
  const km = Math.floor(meters / 1000);
  const rest = Math.floor(meters - km * 1000);
  return `K${km}+${rest.toString().padStart(3, '0')}`;
}

export function formatScore(score: number): string {
  return Math.max(0, Math.round(score)).toLocaleString('en-US');
}
