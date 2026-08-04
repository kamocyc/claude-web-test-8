import {
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';

/**
 * Procedural cloud noise.
 *
 * Two tiling 3D volumes, generated on the CPU at load time like every other
 * texture in this game:
 *
 *   shape  (64^3)  r = Perlin remapped by Worley, gba = Worley at 4/8/16 cells
 *   detail (32^3)  rgb = Worley at 3/6/12 cells
 *
 * The raw bytes are kept so the CPU can sample the same field the raymarcher
 * does - that is what makes the cloud shadow falling across the line agree
 * with the cloud you can see overhead.
 */

const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;

function hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Tiling value noise on a lattice of `cells` per axis, over the unit cube. */
function valueNoise(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = smoother(px - ix);
  const fy = smoother(py - iy);
  const fz = smoother(pz - iz);
  const x0 = ((ix % cells) + cells) % cells;
  const y0 = ((iy % cells) + cells) % cells;
  const z0 = ((iz % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const z1 = (z0 + 1) % cells;

  const c000 = hash(x0, y0, z0, seed);
  const c100 = hash(x1, y0, z0, seed);
  const c010 = hash(x0, y1, z0, seed);
  const c110 = hash(x1, y1, z0, seed);
  const c001 = hash(x0, y0, z1, seed);
  const c101 = hash(x1, y0, z1, seed);
  const c011 = hash(x0, y1, z1, seed);
  const c111 = hash(x1, y1, z1, seed);

  const a = c000 + (c100 - c000) * fx;
  const b = c010 + (c110 - c010) * fx;
  const c = c001 + (c101 - c001) * fx;
  const d = c011 + (c111 - c011) * fx;
  const e = a + (b - a) * fy;
  const f = c + (d - c) * fy;
  return e + (f - e) * fz;
}

/** Feature points for a tiling Worley lattice, three floats per cell. */
function featurePoints(cells: number, seed: number): Float32Array {
  const out = new Float32Array(cells * cells * cells * 3);
  let n = 0;
  for (let z = 0; z < cells; z++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        out[n++] = hash(x, y, z, seed);
        out[n++] = hash(x, y, z, seed + 17);
        out[n++] = hash(x, y, z, seed + 91);
      }
    }
  }
  return out;
}

/** Inverted tiling Worley: 1 at a cell centre, 0 at the cell boundaries. */
function worley(
  x: number,
  y: number,
  z: number,
  cells: number,
  points: Float32Array,
): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  let best = 4;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = ((iz + dz) % cells + cells) % cells;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = ((iy + dy) % cells + cells) % cells;
      const row = (cz * cells + cy) * cells;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ((ix + dx) % cells + cells) % cells;
        const o = (row + cx) * 3;
        const ex = ix + dx + points[o] - px;
        const ey = iy + dy + points[o + 1] - py;
        const ez = iz + dz + points[o + 2] - pz;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function remap(v: number, a: number, b: number, c: number, d: number): number {
  return c + ((v - a) / (b - a)) * (d - c);
}

export interface CloudNoiseData {
  shape: Data3DTexture;
  detail: Data3DTexture;
  /** Raw shape bytes, so the CPU can read the same weather field. */
  shapeBytes: Uint8Array;
  shapeSize: number;
}

let cached: CloudNoiseData | null = null;

export function cloudNoise(): CloudNoiseData {
  if (cached) return cached;

  const n = SHAPE_SIZE;
  const shapeBytes = new Uint8Array(n * n * n * 4);
  const p4 = featurePoints(4, 3);
  const p8 = featurePoints(8, 11);
  const p16 = featurePoints(16, 29);

  let i = 0;
  for (let z = 0; z < n; z++) {
    const fz = z / n;
    for (let y = 0; y < n; y++) {
      const fy = y / n;
      for (let x = 0; x < n; x++) {
        const fx = x / n;
        const w4 = worley(fx, fy, fz, 4, p4);
        const w8 = worley(fx, fy, fz, 8, p8);
        const w16 = worley(fx, fy, fz, 16, p16);
        const wf = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
        const perlin =
          (valueNoise(fx, fy, fz, 3, 101) * 0.55 +
            valueNoise(fx, fy, fz, 6, 211) * 0.29 +
            valueNoise(fx, fy, fz, 12, 307) * 0.16);
        // The Perlin-Worley remap is what gives the field its billowed core
        // and wispy skin rather than the fog-bank look of plain fbm.
        const pw = Math.min(1, Math.max(0, remap(perlin, wf - 1, 1, 0, 1)));
        shapeBytes[i++] = pw * 255;
        shapeBytes[i++] = w4 * 255;
        shapeBytes[i++] = w8 * 255;
        shapeBytes[i++] = w16 * 255;
      }
    }
  }

  const d = DETAIL_SIZE;
  const detailBytes = new Uint8Array(d * d * d * 4);
  const q3 = featurePoints(3, 53);
  const q6 = featurePoints(6, 71);
  const q12 = featurePoints(12, 97);
  let j = 0;
  for (let z = 0; z < d; z++) {
    const fz = z / d;
    for (let y = 0; y < d; y++) {
      const fy = y / d;
      for (let x = 0; x < d; x++) {
        const fx = x / d;
        detailBytes[j++] = worley(fx, fy, fz, 3, q3) * 255;
        detailBytes[j++] = worley(fx, fy, fz, 6, q6) * 255;
        detailBytes[j++] = worley(fx, fy, fz, 12, q12) * 255;
        detailBytes[j++] = 255;
      }
    }
  }

  const shape = new Data3DTexture(shapeBytes, n, n, n);
  shape.format = RGBAFormat;
  shape.type = UnsignedByteType;
  shape.minFilter = LinearFilter;
  shape.magFilter = LinearFilter;
  shape.wrapS = RepeatWrapping;
  shape.wrapT = RepeatWrapping;
  shape.wrapR = RepeatWrapping;
  shape.needsUpdate = true;

  const detail = new Data3DTexture(detailBytes, d, d, d);
  detail.format = RGBAFormat;
  detail.type = UnsignedByteType;
  detail.minFilter = LinearFilter;
  detail.magFilter = LinearFilter;
  detail.wrapS = RepeatWrapping;
  detail.wrapT = RepeatWrapping;
  detail.wrapR = RepeatWrapping;
  detail.needsUpdate = true;

  cached = { shape, detail, shapeBytes, shapeSize: n };
  return cached;
}

/**
 * Trilinear read of one channel of the shape volume, matching what the GPU
 * does so the CPU-side cloud shadow lines up with the clouds in the sky.
 */
export function sampleShape(
  data: CloudNoiseData,
  x: number,
  y: number,
  z: number,
  channel: number,
): number {
  const n = data.shapeSize;
  const px = x * n - 0.5;
  const py = y * n - 0.5;
  const pz = z * n - 0.5;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  const b = data.shapeBytes;
  const wrap = (v: number): number => ((v % n) + n) % n;
  const x0 = wrap(ix);
  const x1 = wrap(ix + 1);
  const y0 = wrap(iy);
  const y1 = wrap(iy + 1);
  const z0 = wrap(iz);
  const z1 = wrap(iz + 1);
  const at = (xx: number, yy: number, zz: number): number =>
    b[((zz * n + yy) * n + xx) * 4 + channel] / 255;

  const c00 = at(x0, y0, z0) + (at(x1, y0, z0) - at(x0, y0, z0)) * fx;
  const c10 = at(x0, y1, z0) + (at(x1, y1, z0) - at(x0, y1, z0)) * fx;
  const c01 = at(x0, y0, z1) + (at(x1, y0, z1) - at(x0, y0, z1)) * fx;
  const c11 = at(x0, y1, z1) + (at(x1, y1, z1) - at(x0, y1, z1)) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}
