import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  Vector3,
} from 'three';
import { MeshBuilder, InstanceCollector } from './MeshBuilder';
import {
  concreteMaterial,
  makeInstanced,
  metalMaterial,
  plainMaterial,
  unitBox,
  unitCylinder,
  asphaltMaterial,
} from './Prefabs';
import { getBallastMaterial, getRailMaterial, getSleeperMaterial, createTerrainMaterial } from '../materials/Materials';
import { blendedGrassColor } from '../world/Biome';
import { trackMatrix, trackPoint } from '../world/TrackFrame';
import { STRUCT_BRIDGE, STRUCT_TUNNEL, TRACK_SPACING, TRACK_GAUGE } from '../world/TrackPath';
import type { ChunkContext } from '../world/ChunkContext';
import { CORRIDOR_HALF } from '../world/TerrainField';
import { clamp01, smoothstep } from '../core/MathUtils';

/**
 * The permanent way and everything bolted to it: formation, ballast, rails,
 * sleepers, overhead line equipment, signals, signs and level crossings.
 */

const HALF_GAUGE = TRACK_GAUGE / 2;
const TRACK_CENTRES = [-TRACK_SPACING / 2, TRACK_SPACING / 2];

/** Lateral positions of the corridor mesh columns, metres from the centre. */
const CORRIDOR_COLUMNS = [
  -CORRIDOR_HALF, -80, -58, -42, -30, -21, -14, -9.5, -7, -5.6, -2.8, 0, 2.8, 5.6, 7, 9.5, 14, 21,
  30, 42, 58, 80, CORRIDOR_HALF,
];

let terrainMaterialSingleton: ReturnType<typeof createTerrainMaterial> | null = null;
export function corridorMaterial() {
  if (!terrainMaterialSingleton) terrainMaterialSingleton = createTerrainMaterial();
  return terrainMaterialSingleton;
}

/**
 * The lineside strip: a fine track-space mesh covering the earthworks that the
 * coarse world tiles underneath cannot resolve.
 */
export function buildFormation(ctx: ChunkContext): void {
  const { samples, field } = ctx;
  const step = 2; // use every second stored sample (4 m)
  const rows: number[] = [];
  for (let i = 0; i < samples.length; i += step) rows.push(i);
  if (rows[rows.length - 1] !== samples.length - 1) rows.push(samples.length - 1);

  const cols = CORRIDOR_COLUMNS.length;
  const count = rows.length * cols;
  // Plus a skirt down each long edge. The corridor is a strip in track space
  // laid over tiles that are a grid in world space, and on a hillside the two
  // do not arrive at the same height at the edge where they meet - so without
  // this there is a slot open along both sides of the line, and through it you
  // see nothing at all.
  const total = count + rows.length * 2;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const colors = new Float32Array(total * 3);
  const slopes = new Float32Array(total);
  const shores = new Float32Array(total);
  const cavities = new Float32Array(total);
  const heights = new Float32Array(count);

  const p = new Vector3();
  const worldPositions: Vector3[] = [];

  for (let r = 0; r < rows.length; r++) {
    const sample = samples[rows[r]];
    for (let c = 0; c < cols; c++) {
      const lateral = CORRIDOR_COLUMNS[c];
      // Horizontal position ignores cant so the ground stays level.
      const rx = -Math.sin(sample.heading);
      const rz = Math.cos(sample.heading);
      const x = sample.x + rx * lateral;
      const z = sample.z + rz * lateral;
      const y = field.ground(sample, lateral, x, z);
      const idx = r * cols + c;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      heights[idx] = y;
      uvs[idx * 2] = x * 0.06;
      uvs[idx * 2 + 1] = z * 0.06;
      const col = blendedGrassColor(sample.weights);
      // Exactly the wash the world tiles use, or the corridor reads as a
      // differently coloured strip laid along the line.
      const tint = 0.88 + field.noise.patches.fbm(x * 0.0016, z * 0.0016, 2) * 0.28;
      colors[idx * 3] = col.r * tint;
      colors[idx * 3 + 1] = col.g * tint;
      colors[idx * 3 + 2] = col.b * tint;
      // The cess: ballast dust and gravel rather than turf for a couple of
      // metres beyond the shoulder, which is what the eye expects beside a
      // running line. The sand sheet doubles as that gravel.
      const cess = 0.6 * (1 - smoothstep(5.4, 11, Math.abs(lateral)));
      // Everything beyond the cess is decided by the same shore function the
      // world tiles use. It had its own rule here - anything within a few
      // metres of sea level is beach - and low-lying farmland is within a few
      // metres of sea level, so the corridor laid a two-hundred-metre strip of
      // sand down the middle of country the tiles were drawing as grass.
      shores[idx] = clamp01(Math.max(cess, field.shoreFactor(sample, lateral, y)));
      worldPositions.push(p.clone().set(x, y, z));
    }
  }

  // Normals from neighbouring grid samples.
  const n = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const left = worldPositions[r * cols + Math.max(0, c - 1)];
      const rightP = worldPositions[r * cols + Math.min(cols - 1, c + 1)];
      const down = worldPositions[Math.max(0, r - 1) * cols + c];
      const upP = worldPositions[Math.min(rows.length - 1, r + 1) * cols + c];
      a.subVectors(rightP, left);
      b.subVectors(upP, down);
      n.crossVectors(b, a).normalize();
      if (n.y < 0) n.negate();
      normals[idx * 3] = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
      slopes[idx] = clamp01(1 - n.y);

      // Curvature, as the discrete Laplacian of the height field, exactly as
      // the world tiles compute it. The ground shader reads this to darken
      // hollows and gather loose stone in them; the corridor did not supply it
      // at all, so the strip beside the line was shading itself from whatever
      // an unbound vertex attribute happened to contain - which is why it read
      // as a two-hundred-metre band of bare soil laid over the fields.
      const spacing = Math.max(4, rightP.distanceTo(left) * 0.5);
      const lap = (left.y + rightP.y + down.y + upP.y) * 0.25 - worldPositions[idx].y;
      cavities[idx] = Math.max(-1, Math.min(1, lap / (spacing * 0.22)));
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i0 = r * cols + c;
      const i1 = i0 + 1;
      const i2 = (r + 1) * cols + c;
      const i3 = i2 + 1;
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }

  // The skirt: the two edge columns copied and dropped by however far the
  // ground moves across the last span of the strip, which is nothing where the
  // line runs over a plain and metres where it runs along a hillside.
  const skirt = (r: number, edge: 0 | 1): number => {
    const c = edge === 0 ? 0 : cols - 1;
    const src = r * cols + c;
    const inner = r * cols + (edge === 0 ? 1 : cols - 2);
    const along =
      Math.abs(heights[Math.min(rows.length - 1, r + 1) * cols + c] - heights[Math.max(0, r - 1) * cols + c]);
    const across = Math.abs(heights[src] - heights[inner]);
    const drop = Math.min(24, 1.5 + Math.max(across, along) * 1.3);
    const v = count + r * 2 + edge;
    positions[v * 3] = positions[src * 3];
    positions[v * 3 + 1] = positions[src * 3 + 1] - drop;
    positions[v * 3 + 2] = positions[src * 3 + 2];
    normals[v * 3] = normals[src * 3];
    normals[v * 3 + 1] = normals[src * 3 + 1];
    normals[v * 3 + 2] = normals[src * 3 + 2];
    uvs[v * 2] = uvs[src * 2];
    uvs[v * 2 + 1] = uvs[src * 2 + 1];
    colors[v * 3] = colors[src * 3];
    colors[v * 3 + 1] = colors[src * 3 + 1];
    colors[v * 3 + 2] = colors[src * 3 + 2];
    slopes[v] = slopes[src];
    shores[v] = shores[src];
    cavities[v] = cavities[src];
    return v;
  };
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * cols;
    const b = (r + 1) * cols;
    const sa = skirt(r, 0);
    const sb = skirt(r + 1, 0);
    const c = r * cols + cols - 1;
    const d = (r + 1) * cols + cols - 1;
    const sc = skirt(r, 1);
    const sd = skirt(r + 1, 1);
    // Both windings. The material is single sided and which way round these
    // face depends on which way the line is heading; a skirt is never looked
    // at directly, so it costs two triangles a row to stop caring.
    indices.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
    indices.push(c, d, sc, d, sd, sc, c, sc, d, d, sc, sd);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('aSlope', new BufferAttribute(slopes, 1));
  geometry.setAttribute('aShore', new BufferAttribute(shores, 1));
  geometry.setAttribute('aCavity', new BufferAttribute(cavities, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, corridorMaterial());
  mesh.name = 'formation';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = -5;
  mesh.userData.ownsGeometry = true;
  ctx.group.add(mesh);
}

/** Ballast prism: level top under the sleepers with 1:1.5 shoulders. */
export function buildBallast(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const columns = [-5.6, -4.4, 4.4, 5.6];
  const colHeights = [-0.9, -0.345, -0.345, -0.9];
  const rows: Vector3[][] = [];
  const uvV: number[] = [];
  const colorTop = new Color(0.94, 0.92, 0.88);
  const colorShoulder = new Color(0.72, 0.70, 0.66);
  const colColors = [colorShoulder, colorTop, colorTop, colorShoulder];

  let started = false;
  for (const sample of ctx.samples) {
    if (sample.structure === STRUCT_BRIDGE) {
      if (started) flushBallast(builder, rows, uvV, colColors);
      rows.length = 0;
      uvV.length = 0;
      started = false;
      continue;
    }
    started = true;
    const row: Vector3[] = [];
    for (let c = 0; c < columns.length; c++) {
      row.push(trackPoint(sample, columns[c], colHeights[c], new Vector3()));
    }
    rows.push(row);
    uvV.push(sample.s * 0.32);
  }
  if (rows.length > 1) flushBallast(builder, rows, uvV, colColors);

  const mesh = builder.toMesh(getBallastMaterial(), true, 'ballast');
  if (mesh) {
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
}

function flushBallast(builder: MeshBuilder, rows: Vector3[][], uvV: number[], colors: Color[]): void {
  if (rows.length < 2) return;
  builder.addSweep(rows, colors, uvV, [0, 0.42, 3.1, 3.5]);
}

/** Rail cross-section: (lateral, height) relative to the rail head top. */
const RAIL_PROFILE: [number, number][] = [
  [-0.0355, 0.0],
  [0.0355, 0.0],
  [0.0375, -0.018],
  [0.030, -0.044],
  [0.013, -0.058],
  [0.013, -0.100],
  [0.052, -0.116],
  [0.064, -0.145],
  [-0.064, -0.145],
  [-0.052, -0.116],
  [-0.013, -0.100],
  [-0.013, -0.058],
  [-0.030, -0.044],
  [-0.0375, -0.018],
];

export function buildRails(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const head = new Color(1.35, 1.35, 1.32);
  const web = new Color(0.42, 0.40, 0.37);
  const colColors = RAIL_PROFILE.map(([, h]) => (h > -0.02 ? head : web));
  const uvU = RAIL_PROFILE.map((_, i) => i / RAIL_PROFILE.length);

  for (const centre of TRACK_CENTRES) {
    for (const side of [-1, 1]) {
      const offset = centre + side * HALF_GAUGE;
      const rows: Vector3[][] = [];
      const uvV: number[] = [];
      for (const sample of ctx.samples) {
        const row: Vector3[] = [];
        for (const [lat, h] of RAIL_PROFILE) {
          row.push(trackPoint(sample, offset + lat, h, new Vector3()));
        }
        rows.push(row);
        uvV.push(sample.s * 0.5);
      }
      builder.addSweep(rows, colColors, uvV, uvU, true);
    }
  }

  const mesh = builder.toMesh(getRailMaterial(), true, 'rails');
  if (mesh) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
}

/** Concrete sleepers with their fastenings, instanced along both roads. */
export function buildSleepers(ctx: ChunkContext): void {
  const collector = new InstanceCollector();
  const matrix = new Matrix4();
  const scale = new Vector3(2.4, 0.2, 0.24);
  const spacing = 0.6;
  const color = new Color();

  const start = Math.ceil(ctx.sStart / spacing) * spacing;
  for (let s = start; s < ctx.sEnd; s += spacing) {
    const sample = ctx.track.sampleAt(s);
    if (sample.structure === STRUCT_BRIDGE) continue;
    for (const centre of TRACK_CENTRES) {
      const shade = 0.82 + ctx.rng.next() * 0.3;
      color.setRGB(shade, shade * 0.99, shade * 0.95);
      trackMatrix(sample, centre, -0.345, matrix, 0, scale);
      collector.push(matrix, color);
    }
  }

  const mesh = makeInstanced(unitBox(), getSleeperMaterial(), collector, {
    castShadow: true,
    receiveShadow: true,
    name: 'sleepers',
  });
  if (mesh) ctx.group.add(mesh);
}

/**
 * Overhead line equipment: masts, cantilevers, messenger and contact wires
 * with a realistic sag and stagger, and the droppers between them.
 */
export function buildCatenary(ctx: ChunkContext): void {
  const structure = new MeshBuilder();
  const wires = new MeshBuilder();
  const mastColor = new Color(0.62, 0.63, 0.64);
  const wireColor = new Color(0.30, 0.24, 0.18);
  const matrix = new Matrix4();
  const scale = new Vector3();

  const spacing = 45;
  const mastHeight = 7.4;
  const messengerH = 6.3;
  const contactH = 5.15;

  const firstMast = Math.ceil(ctx.sStart / spacing) * spacing;

  for (let s = firstMast; s < ctx.sEnd; s += spacing) {
    const sample = ctx.track.sampleAt(s);
    if (sample.structure === STRUCT_TUNNEL) continue;
    for (const side of [-1, 1]) {
      const lateral = side * 6.5;
      // Mast.
      scale.set(0.26, mastHeight, 0.26);
      trackMatrix(sample, lateral, -0.35, matrix, 0, scale);
      structure.add(unitBox(), matrix, mastColor);
      // Base.
      scale.set(0.55, 0.35, 0.55);
      trackMatrix(sample, lateral, -0.6, matrix, 0, scale);
      structure.add(unitBox(), matrix, mastColor);
      // Cantilever arm reaching over its road.
      const reach = 6.5 - Math.abs(TRACK_CENTRES[side < 0 ? 0 : 1]);
      scale.set(reach, 0.12, 0.12);
      trackMatrix(sample, lateral - side * reach * 0.5, messengerH + 0.5, matrix, 0, scale);
      structure.add(unitBox(), matrix, mastColor);
      // Diagonal stay.
      scale.set(0.1, 2.4, 0.1);
      trackMatrix(sample, lateral - side * 0.9, messengerH - 1.5, matrix, 0, scale);
      structure.add(unitBox(), matrix, mastColor);
    }
  }

  // Wires, span by span.
  for (let i = 0; i < TRACK_CENTRES.length; i++) {
    const centre = TRACK_CENTRES[i];
    for (let s = firstMast - spacing; s < ctx.sEnd; s += spacing) {
      if (s + spacing < ctx.sStart) continue;
      const startSample = ctx.track.sampleAt(s);
      if (startSample.structure === STRUCT_TUNNEL) continue;
      const segments = 8;
      const staggerA = ((Math.round(s / spacing) % 2) * 2 - 1) * 0.2;
      const staggerB = -staggerA;

      const messengerRows: Vector3[][] = [];
      const contactRows: Vector3[][] = [];
      const uvV: number[] = [];
      for (let k = 0; k <= segments; k++) {
        const t = k / segments;
        const ss = s + t * spacing;
        const sample = ctx.track.sampleAt(ss);
        // Parabolic sag.
        const sag = 4 * t * (1 - t);
        const stagger = staggerA + (staggerB - staggerA) * t;
        messengerRows.push(wireSection(sample, centre + stagger * 0.5, messengerH - sag * 0.32, 0.018));
        contactRows.push(wireSection(sample, centre + stagger, contactH - sag * 0.05, 0.014));
        uvV.push(t);
      }
      wires.addSweep(messengerRows, wireColor, uvV, [0, 0.25, 0.5, 0.75], true);
      wires.addSweep(contactRows, wireColor, uvV, [0, 0.25, 0.5, 0.75], true);

      // Droppers.
      if (ctx.detailed) {
        for (let k = 1; k < segments; k++) {
          const t = k / segments;
          const ss = s + t * spacing;
          const sample = ctx.track.sampleAt(ss);
          const sag = 4 * t * (1 - t);
          const top = messengerH - sag * 0.32;
          const bottom = contactH - sag * 0.05;
          scale.set(0.02, top - bottom, 0.02);
          trackMatrix(sample, centre + (staggerA + (staggerB - staggerA) * t), bottom, matrix, 0, scale);
          wires.add(unitBox(), matrix, wireColor);
        }
      }
    }
  }

  const structureMesh = structure.toMesh(metalMaterial(), false, 'catenary-masts');
  if (structureMesh) {
    structureMesh.castShadow = true;
    ctx.group.add(structureMesh);
  }
  const wireMesh = wires.toMesh(plainMaterial(), true, 'catenary-wires');
  if (wireMesh) ctx.group.add(wireMesh);
}

/** Square cross-section of a wire at a given point, as four corners. */
function wireSection(
  sample: Parameters<typeof trackPoint>[0],
  lateral: number,
  height: number,
  radius: number,
): Vector3[] {
  // Clockwise in the section plane, so the tube faces outwards.
  return [
    trackPoint(sample, lateral - radius, height + radius, new Vector3()),
    trackPoint(sample, lateral + radius, height + radius, new Vector3()),
    trackPoint(sample, lateral + radius, height - radius, new Vector3()),
    trackPoint(sample, lateral - radius, height - radius, new Vector3()),
  ];
}

const LAMP_OFF = new MeshBasicMaterial({ color: 0x14161a });
const LAMP_RED = new MeshBasicMaterial({ color: 0xff2a18 });
const LAMP_YELLOW = new MeshBasicMaterial({ color: 0xffb020 });
const LAMP_GREEN = new MeshBasicMaterial({ color: 0x28ff7a });
export const SIGNAL_LAMP_MATERIALS = {
  off: LAMP_OFF,
  red: LAMP_RED,
  yellow: LAMP_YELLOW,
  green: LAMP_GREEN,
};

/** Colour light signals on lattice masts, facing the driver. */
export function buildSignals(ctx: ChunkContext): void {
  for (const info of ctx.track.signals) {
    if (info.s < ctx.sStart || info.s >= ctx.sEnd) continue;
    const sample = ctx.track.sampleAt(info.s);
    if (sample.structure === STRUCT_TUNNEL) continue;

    const group = new Group();
    const builder = new MeshBuilder();
    const matrix = new Matrix4();
    const scale = new Vector3();
    const grey = new Color(0.42, 0.44, 0.46);
    const dark = new Color(0.16, 0.17, 0.18);
    const lateral = -7.6; // outside the left-hand road, where the driver looks

    scale.set(0.18, 5.6, 0.18);
    trackMatrix(sample, lateral, -0.4, matrix, 0, scale);
    builder.add(unitCylinder(8), matrix, grey);
    scale.set(0.6, 0.25, 0.6);
    trackMatrix(sample, lateral, -0.55, matrix, 0, scale);
    builder.add(unitCylinder(8), matrix, grey);
    // Head backing plate.
    scale.set(0.62, 1.5, 0.16);
    trackMatrix(sample, lateral, 4.4, matrix, 0, scale);
    builder.add(unitBox(), matrix, dark);
    // Hoods.
    for (let i = 0; i < 3; i++) {
      scale.set(0.34, 0.34, 0.22);
      trackMatrix(sample, lateral, 4.62 + i * 0.42, matrix, 0, scale);
      builder.add(unitCylinder(10), matrix, dark);
    }

    const mesh = builder.toMesh(metalMaterial(), false, 'signal');
    if (mesh) {
      mesh.castShadow = true;
      group.add(mesh);
    }

    const lamps: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const lamp = new Mesh(unitCylinder(10), LAMP_OFF);
      const m = new Matrix4();
      trackMatrix(sample, lateral, 4.66 + i * 0.42, m, 0, new Vector3(0.24, 0.06, 0.24));
      // Face the lens towards oncoming trains.
      lamp.applyMatrix4(m);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      lamps.push(lamp);
      group.add(lamp);
    }

    ctx.group.add(group);
    ctx.signals.push({ info, lamps: [lamps[0], lamps[1], lamps[2]] as [Mesh, Mesh, Mesh] });
  }
}

/** Speed limit signs and kilometre posts. */
export function buildSigns(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const white = new Color(0.95, 0.95, 0.92);
  const post = new Color(0.6, 0.6, 0.58);

  for (let s = Math.ceil(ctx.sStart / 200) * 200; s < ctx.sEnd; s += 200) {
    const sample = ctx.track.sampleAt(s);
    if (sample.structure === STRUCT_TUNNEL) continue;
    scale.set(0.1, 1.1, 0.1);
    trackMatrix(sample, -7.0, -0.5, matrix, 0, scale);
    builder.add(unitBox(), matrix, post);
    scale.set(0.34, 0.34, 0.05);
    trackMatrix(sample, -7.0, 0.6, matrix, 0, scale);
    builder.add(unitBox(), matrix, white);
  }

  for (const sign of ctx.track.speedSigns) {
    if (sign.s < ctx.sStart || sign.s >= ctx.sEnd) continue;
    const sample = ctx.track.sampleAt(sign.s);
    scale.set(0.09, 2.1, 0.09);
    trackMatrix(sample, -7.2, -0.5, matrix, 0, scale);
    builder.add(unitBox(), matrix, post);
    scale.set(0.72, 0.72, 0.06);
    trackMatrix(sample, -7.2, 1.6, matrix, 0, scale);
    builder.add(unitBox(), matrix, white);
  }

  const mesh = builder.toMesh(concreteMaterial(), false, 'signs');
  if (mesh) {
    mesh.castShadow = true;
    ctx.group.add(mesh);
  }
}

/** Level crossings: road surface, warning devices and animated barriers. */
export function buildCrossings(ctx: ChunkContext): void {
  for (const info of ctx.track.crossings) {
    if (info.s < ctx.sStart || info.s >= ctx.sEnd) continue;
    const sample = ctx.track.sampleAt(info.s);
    if (sample.structure !== 0) continue;

    const road = new MeshBuilder();
    const props = new MeshBuilder();
    const matrix = new Matrix4();
    const scale = new Vector3();
    const asphalt = new Color(0.55, 0.55, 0.56);
    const deck = new Color(0.72, 0.71, 0.68);
    const poleColor = new Color(0.95, 0.93, 0.86);
    const dark = new Color(0.2, 0.2, 0.22);

    // Road crossing the line, plus the timber deck between the rails.
    const halfWidth = info.width * 0.5;
    const roadRows: Vector3[][] = [];
    const uvV: number[] = [];
    for (let k = -1; k <= 1; k += 2) {
      const s = info.s + k * halfWidth;
      const row: Vector3[] = [];
      for (const lat of [-26, -6.2, 6.2, 26]) {
        const sm = ctx.track.sampleAt(s);
        const rx = -Math.sin(sm.heading);
        const rz = Math.cos(sm.heading);
        const x = sm.x + rx * lat;
        const z = sm.z + rz * lat;
        const groundY = ctx.field.ground(sm, lat, x, z);
        const y = Math.abs(lat) < 7 ? sm.y - 0.12 : Math.max(groundY + 0.06, sm.y - 0.55);
        row.push(new Vector3(x, y, z));
      }
      roadRows.push(row);
      uvV.push(k * halfWidth * 0.2);
    }
    road.addSweep(roadRows, asphalt, uvV, [0, 0.4, 0.6, 1]);

    // Deck panels flush with the rail head.
    scale.set(13, 0.14, info.width);
    trackMatrix(sample, 0, -0.02, matrix, 0, scale);
    props.add(unitBox(), matrix, deck);

    const barriers: Group[] = [];
    const lamps: Mesh[] = [];
    for (const side of [-1, 1]) {
      const lateral = side * (7.4 + info.width * 0.1);
      const sOffset = info.s + side * (halfWidth + 1.4);
      const postSample = ctx.track.sampleAt(sOffset);

      scale.set(0.16, 3.1, 0.16);
      trackMatrix(postSample, lateral, -0.5, matrix, 0, scale);
      props.add(unitBox(), matrix, poleColor);

      // Warning cross and lamps.
      scale.set(1.5, 0.16, 0.08);
      trackMatrix(postSample, lateral, 2.5, matrix, Math.PI / 5, scale);
      props.add(unitBox(), matrix, poleColor);
      scale.set(1.5, 0.16, 0.08);
      trackMatrix(postSample, lateral, 2.5, matrix, -Math.PI / 5, scale);
      props.add(unitBox(), matrix, poleColor);
      scale.set(0.9, 0.3, 0.12);
      trackMatrix(postSample, lateral, 1.9, matrix, 0, scale);
      props.add(unitBox(), matrix, dark);

      for (const lampSide of [-1, 1]) {
        const lamp = new Mesh(unitCylinder(8), LAMP_OFF);
        const m = new Matrix4();
        trackMatrix(postSample, lateral + lampSide * 0.28, 2.0, m, 0, new Vector3(0.2, 0.08, 0.2));
        lamp.applyMatrix4(m);
        lamp.matrixAutoUpdate = false;
        lamp.updateMatrix();
        lamps.push(lamp);
        ctx.group.add(lamp);
      }

      // Barrier: a pivot group so it can be animated down over the road.
      const pivot = new Group();
      const pivotMatrix = new Matrix4();
      trackMatrix(postSample, lateral, 1.05, pivotMatrix, 0);
      pivot.applyMatrix4(pivotMatrix);

      // Local space: +X is the track's right vector, +Y up. The arm reaches
      // inwards across the road and pivots up about the along-track axis.
      const armBuilder = new MeshBuilder();
      const armLength = 5.4;
      const armMatrix = new Matrix4();
      armMatrix.makeScale(armLength, 0.14, 0.14);
      armMatrix.setPosition(-side * armLength * 0.5, 0, 0);
      armBuilder.add(unitBox(), armMatrix, new Color(1, 0.98, 0.94));
      // Hazard stripes.
      for (let k = 0; k < 5; k++) {
        const stripe = new Matrix4();
        stripe.makeScale(armLength * 0.09, 0.15, 0.15);
        stripe.setPosition(-side * (0.55 + k * 1.05), 0, 0);
        armBuilder.add(unitBox(), stripe, new Color(0.85, 0.12, 0.1));
      }
      const armMesh = armBuilder.toMesh(plainMaterial(), false, 'barrier-arm');
      if (armMesh) {
        armMesh.castShadow = true;
        pivot.add(armMesh);
      }
      pivot.userData.side = side;
      pivot.rotation.z = -side * Math.PI * 0.5;
      ctx.group.add(pivot);
      barriers.push(pivot);
    }

    const roadMesh = road.toMesh(asphaltMaterial(), true, 'crossing-road');
    if (roadMesh) {
      roadMesh.receiveShadow = true;
      ctx.group.add(roadMesh);
    }
    const propsMesh = props.toMesh(plainMaterial(), false, 'crossing-props');
    if (propsMesh) {
      propsMesh.castShadow = true;
      ctx.group.add(propsMesh);
    }

    ctx.crossings.push({ info, barriers, lamps, state: 0, bellPhase: 0 });
  }
}
