import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { MeshBuilder } from './MeshBuilder';
import { concreteMaterial, metalMaterial, unitBox, unitCylinder } from './Prefabs';
import { corridorMaterial } from './TrackBuilder';
import { textures } from '../materials/TextureFactory';
import { blendedGrassColor } from '../world/Biome';
import { clamp01, smoothstep } from '../core/MathUtils';
import { trackMatrix, trackPoint } from '../world/TrackFrame';
import type { ChunkContext } from '../world/ChunkContext';
import type { TrackSample, TunnelInfo } from '../world/TrackPath';

/**
 * Bridges and tunnels.
 *
 * Both are generated from the route's structure list, so a chunk only builds
 * the part of a structure that falls inside it and long bores stay seamless.
 */

export function buildBridges(ctx: ChunkContext): void {
  for (const bridge of ctx.track.bridges) {
    if (bridge.sEnd < ctx.sStart || bridge.sStart >= ctx.sEnd) continue;
    const from = Math.max(bridge.sStart, ctx.sStart);
    const to = Math.min(bridge.sEnd, ctx.sEnd);

    const structure = new MeshBuilder();
    const deck = new MeshBuilder();
    const matrix = new Matrix4();
    const scale = new Vector3();
    const steel = new Color(0.36, 0.44, 0.5);
    const concrete = new Color(0.78, 0.77, 0.74);

    const step = 5;
    for (let s = from; s < to; s += step) {
      const sample = ctx.track.sampleAt(s);
      // Deck slab carrying the ballast.
      scale.set(11.4, 0.55, step + 0.1);
      trackMatrix(sample, 0, -1.45, matrix, 0, scale);
      deck.add(unitBox(), matrix, concrete);
      // Main girders under each road.
      for (const side of [-1, 1]) {
        scale.set(0.5, 1.5, step + 0.1);
        trackMatrix(sample, side * 3.4, -2.9, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
      // Parapet.
      for (const side of [-1, 1]) {
        scale.set(0.22, 1.15, step + 0.1);
        trackMatrix(sample, side * 5.6, -0.9, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
    }

    // Piers down to the ground, spaced along the span.
    const pierSpacing = bridge.kind === 'viaduct' ? 18 : 34;
    for (let s = Math.ceil(from / pierSpacing) * pierSpacing; s < to; s += pierSpacing) {
      const sample = ctx.track.sampleAt(s);
      const p = trackPoint(sample, 0, 0, new Vector3());
      const groundY = ctx.field.natural(sample, 0, p.x, p.z);
      const height = Math.max(1.5, sample.y - 2.9 - groundY);
      scale.set(2.6, height, 2.0);
      trackMatrix(sample, 0, -2.9 - height, matrix, 0, scale);
      structure.add(unitBox(), matrix, concrete);
      scale.set(4.2, 0.8, 3.2);
      trackMatrix(sample, 0, -2.9 - height, matrix, 0, scale);
      structure.add(unitBox(), matrix, concrete);
    }

    // Truss bridges get a through-truss above the deck.
    if (bridge.kind === 'truss') {
      const panel = 7;
      for (let s = from; s < to - panel; s += panel) {
        const sample = ctx.track.sampleAt(s);
        for (const side of [-1, 1]) {
          scale.set(0.28, 6.4, 0.28);
          trackMatrix(sample, side * 5.6, -0.4, matrix, 0, scale);
          structure.add(unitBox(), matrix, steel);
          // Diagonal.
          const diag = new Matrix4();
          trackMatrix(sample, side * 5.6, 2.6, diag, 0);
          const local = new Matrix4()
            .makeRotationX(Math.atan2(panel, 6))
            .premultiply(diag);
          const scaled = new Matrix4().makeScale(0.22, Math.hypot(panel, 6), 0.22);
          structure.add(unitBox(), local.multiply(scaled), steel);
          // Top chord.
          scale.set(0.3, 0.3, panel + 0.1);
          trackMatrix(sample, side * 5.6, 5.9, matrix, 0, scale);
          structure.add(unitBox(), matrix, steel);
        }
        // Cross bracing overhead.
        scale.set(11.2, 0.24, 0.24);
        trackMatrix(sample, 0, 6.0, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
    }

    const deckMesh = deck.toMesh(concreteMaterial(), false, 'bridge-deck');
    if (deckMesh) {
      deckMesh.receiveShadow = true;
      deckMesh.castShadow = true;
      ctx.group.add(deckMesh);
    }
    const structureMesh = structure.toMesh(metalMaterial(), false, 'bridge-structure');
    if (structureMesh) {
      structureMesh.castShadow = true;
      structureMesh.receiveShadow = true;
      ctx.group.add(structureMesh);
    }
  }
}

// --- tunnels ---------------------------------------------------------------

/**
 * Bore section, as offsets from the rail head: vertical side walls carrying a
 * cable shelf, then a segmental arch over them.
 */
const BORE_RADIUS = 5.3;
/** Height at which the arch springs from the side walls. */
const BORE_SPRING = 2.1;
/** Rise of the arch above the springing. */
const BORE_RISE = 3.95;
/** Foot of the side walls, below the top of the ballast. */
const BORE_INVERT = -1.5;
/** Depth of the cable shelf set into each side wall. */
const BORE_SHELF = 0.44;
/** Half width of the portal head wall. */
const PORTAL_HALF = 8.6;

/** Height of the arch soffit at a lateral offset, or -Infinity outside it. */
function archHeight(lateral: number): number {
  const t = Math.abs(lateral) / BORE_RADIUS;
  if (t >= 1) return -Infinity;
  return BORE_SPRING + Math.sqrt(1 - t * t) * BORE_RISE;
}

let boreProfileCache: [number, number][] | null = null;
function boreProfile(): [number, number][] {
  if (boreProfileCache) return boreProfileCache;
  const p: [number, number][] = [];
  const side = (sign: number): [number, number][] => [
    [sign * BORE_RADIUS, BORE_INVERT],
    [sign * BORE_RADIUS, 0.5],
    [sign * (BORE_RADIUS - BORE_SHELF), 0.66],
    [sign * (BORE_RADIUS - BORE_SHELF), 1.06],
    [sign * BORE_RADIUS, 1.22],
    [sign * BORE_RADIUS, BORE_SPRING],
  ];
  p.push(...side(-1));
  const steps = 18;
  for (let i = 1; i < steps; i++) {
    const a = Math.PI - (i / steps) * Math.PI;
    p.push([Math.cos(a) * BORE_RADIUS, BORE_SPRING + Math.sin(a) * BORE_RISE]);
  }
  p.push(...side(1).reverse());
  boreProfileCache = p;
  return p;
}

let tunnelInteriorMaterial: MeshStandardMaterial | null = null;
function getTunnelMaterial(): MeshStandardMaterial {
  if (!tunnelInteriorMaterial) {
    tunnelInteriorMaterial = new MeshStandardMaterial({
      map: textures.tunnelLining(),
      normalMap: textures.tunnelLiningNormal(),
      color: 0x8b8781,
      roughness: 0.95,
      metalness: 0,
      side: BackSide,
      vertexColors: true,
    });
  }
  return tunnelInteriorMaterial;
}

/** World position of a lateral offset, ignoring cant, for querying the ground. */
function lateralPoint(sample: TrackSample, lateral: number, out: Vector3): Vector3 {
  const rx = -Math.sin(sample.heading);
  const rz = Math.cos(sample.heading);
  return out.set(sample.x + rx * lateral, sample.y, sample.z + rz * lateral);
}

/** Chainages at which to build a section, anchored to a global grid so that
 *  the piece built by one chunk meets the piece built by the next exactly. */
function sectionRows(from: number, to: number, step: number): number[] {
  const rows = [from];
  for (let s = Math.ceil((from + 0.01) / step) * step; s < to - 0.01; s += step) rows.push(s);
  rows.push(to);
  return rows;
}

/**
 * The ground closes over a bore, but a height field cannot arch over the line:
 * `TerrainField` leaves a slot open along the tunnel and this caps it, rising
 * from just clear of the arch at the portal to the full hillside a little way
 * in. The cap is drawn with the terrain material and meets the hillside exactly
 * where the two heights agree, so there is no seam to see.
 */
function capHeight(ctx: ChunkContext, tunnel: TunnelInfo, sample: TrackSample, lateral: number): number {
  const p = lateralPoint(sample, lateral, scratchA);
  const ground = ctx.field.ground(sample, lateral, p.x, p.z);
  const inside = Math.min(sample.s - tunnel.sStart, tunnel.sEnd - sample.s);
  const arch = archHeight(lateral);
  // Just above the arch at the mouth, falling away fast to either side so the
  // cap comes down to meet the cutting beside the portal.
  const roof =
    sample.y + (arch === -Infinity ? BORE_SPRING - (Math.abs(lateral) - BORE_RADIUS) * 3.2 : arch) + 1.35;
  const hill = ctx.field.tunnelCoverHeight(sample, lateral, p.x, p.z);
  const blend = smoothstep(0, 26, inside);
  return Math.max(ground, roof + (hill - roof) * blend);
}

function buildTunnelCap(ctx: ChunkContext, tunnel: TunnelInfo, from: number, to: number): void {
  const cap = new MeshBuilder();
  const columns = 13;
  const rows: Vector3[][] = [];
  const uvV: number[] = [];
  const colors: Color[] = [];
  const point = new Vector3();

  for (const s of sectionRows(from, to, 4)) {
    const sample = ctx.track.sampleAt(s);
    // How far out the cap has to reach before it lies on the hillside anyway.
    let edge = 9;
    for (let lat = 9; lat <= 72; lat += 3) {
      const p = lateralPoint(sample, lat, scratchB);
      if (capHeight(ctx, tunnel, sample, lat) <= ctx.field.ground(sample, lat, p.x, p.z) + 0.03) break;
      edge = lat + 3;
    }

    const row: Vector3[] = [];
    for (let c = 0; c < columns; c++) {
      const lat = (c / (columns - 1) - 0.5) * 2 * edge;
      const p = lateralPoint(sample, lat, point);
      row.push(new Vector3(p.x, capHeight(ctx, tunnel, sample, lat) + 0.04, p.z));
    }
    rows.push(row);
    uvV.push(s * 0.05);
  }
  if (rows.length < 2) return;

  const grass = blendedGrassColor(ctx.track.sampleAt((from + to) * 0.5).weights);
  for (let c = 0; c < columns; c++) colors.push(grass);
  cap.addSweep(rows, colors, uvV, rows[0].map((_, c) => c / (columns - 1)), false);

  const geometry = cap.toGeometry(true);
  addTerrainAttributes(geometry);
  const mesh = new Mesh(geometry, corridorMaterial());
  mesh.name = 'tunnel-cap';
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = true;
  mesh.userData.ownsGeometry = true;
  ctx.group.add(mesh);
}

/** The terrain material reads a slope and a shoreline weight per vertex. */
function addTerrainAttributes(geometry: BufferGeometry): void {
  const normal = geometry.getAttribute('normal');
  const count = normal.count;
  const slope = new Float32Array(count);
  const shore = new Float32Array(count);
  for (let i = 0; i < count; i++) slope[i] = clamp01(1 - Math.abs(normal.getY(i)));
  geometry.setAttribute('aSlope', new BufferAttribute(slope, 1));
  geometry.setAttribute('aShore', new BufferAttribute(shore, 1));
}

interface WallColumn {
  lateral: number;
  /** Heights relative to the rail head. */
  bottom: number;
  top: number;
}

/**
 * A slab of masonry standing across the line, built from a column profile with
 * front, back and rim faces so it reads as solid from either side.
 */
function buildWallSlab(
  builder: MeshBuilder,
  sample: TrackSample,
  inner: TrackSample,
  columns: WallColumn[],
  color: Color,
  flip: boolean,
): void {
  const at = (sm: TrackSample, lat: number, h: number) => trackPoint(sm, lat, h, new Vector3());
  for (let i = 0; i < columns.length - 1; i++) {
    const a = columns[i];
    const b = columns[i + 1];
    if (a.top <= a.bottom && b.top <= b.bottom) continue;
    const aTop = Math.max(a.top, a.bottom);
    const bTop = Math.max(b.top, b.bottom);
    // Face towards the open air, and the same face again at the back.
    builder.addQuad(
      at(sample, a.lateral, a.bottom), at(sample, b.lateral, b.bottom),
      at(sample, b.lateral, bTop), at(sample, a.lateral, aTop),
      color, [0, 0, 1, 1], flip,
    );
    builder.addQuad(
      at(inner, a.lateral, a.bottom), at(inner, b.lateral, b.bottom),
      at(inner, b.lateral, bTop), at(inner, a.lateral, aTop),
      color, [0, 0, 1, 1], !flip,
    );
    // Soffit and coping joining the two faces.
    builder.addQuad(
      at(sample, a.lateral, a.bottom), at(sample, b.lateral, b.bottom),
      at(inner, b.lateral, b.bottom), at(inner, a.lateral, a.bottom),
      color, [0, 0, 1, 1], !flip,
    );
    builder.addQuad(
      at(sample, a.lateral, aTop), at(sample, b.lateral, bTop),
      at(inner, b.lateral, bTop), at(inner, a.lateral, aTop),
      color, [0, 0, 1, 1], flip,
    );
  }
  // Close the two ends.
  for (const [column, last] of [[columns[0], false], [columns[columns.length - 1], true]] as [WallColumn, boolean][]) {
    const top = Math.max(column.top, column.bottom);
    if (top <= column.bottom + 0.01) continue;
    builder.addQuad(
      at(sample, column.lateral, column.bottom), at(inner, column.lateral, column.bottom),
      at(inner, column.lateral, top), at(sample, column.lateral, top),
      color, [0, 0, 1, 1], last ? flip : !flip,
    );
  }
}

/**
 * Portal head wall: a face wall with the bore punched through it, standing in
 * the cutting at the tunnel mouth, plus the ring of masonry that frames the
 * opening.
 */
function buildPortal(ctx: ChunkContext, tunnel: TunnelInfo, portalS: number, dir: number): void {
  const builder = new MeshBuilder();
  const face = ctx.track.sampleAt(portalS - dir * 0.05);
  const back = ctx.track.sampleAt(portalS + dir * 1.15);
  const concrete = new Color(0.74, 0.72, 0.68);
  const ring = new Color(0.66, 0.64, 0.6);
  const point = new Vector3();

  const columns: WallColumn[] = [];
  const ringColumns: WallColumn[] = [];
  for (let lat = -PORTAL_HALF; lat <= PORTAL_HALF + 1e-6; lat += 0.35) {
    const p = lateralPoint(face, lat, point);
    const ground = ctx.field.ground(face, lat, p.x, p.z) - face.y;
    const arch = archHeight(lat);
    // The opening is cut a little wider than the lining so the ring stands
    // proud of it instead of fighting with it.
    const opening = arch === -Infinity ? -Infinity : arch + 0.14;
    const bottom = Math.max(ground - 0.4, opening);
    const cap = capHeight(ctx, tunnel, face, lat) - face.y;
    // Away from the opening the cap comes down to the cutting itself, and no
    // wall is wanted: only what actually holds the hillside back is built.
    const top = cap > ground + 0.12 ? cap + 0.45 : bottom;
    columns.push({ lateral: lat, bottom, top });
    const shoulder = opening > -Infinity ? opening : BORE_SPRING - (Math.abs(lat) - BORE_RADIUS) * 2.2;
    if (Math.abs(lat) < BORE_RADIUS + 1.25 && shoulder > ground + 0.2) {
      ringColumns.push({ lateral: lat, bottom: shoulder, top: Math.min(top, shoulder + 0.9) });
    }
  }

  const flip = dir < 0;
  buildWallSlab(builder, face, back, columns, concrete, flip);
  if (ringColumns.length > 1) {
    const proud = ctx.track.sampleAt(portalS - dir * 0.45);
    buildWallSlab(builder, proud, face, ringColumns, ring, flip);
  }

  const mesh = builder.toMesh(concreteMaterial(), false, 'tunnel-portal');
  if (mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
}

/** Tunnel bore, portals, the hillside over the top and the lights inside. */
export function buildTunnels(ctx: ChunkContext): void {
  for (const tunnel of ctx.track.tunnels) {
    if (tunnel.sEnd < ctx.sStart || tunnel.sStart >= ctx.sEnd) continue;
    const from = Math.max(tunnel.sStart, ctx.sStart);
    const to = Math.min(tunnel.sEnd, ctx.sEnd);
    if (to - from < 0.5) continue;

    const profile = boreProfile();
    const bore = new MeshBuilder();
    const rings = new MeshBuilder();
    const rows: Vector3[][] = [];
    const uvV: number[] = [];

    for (const s of sectionRows(from, to, 3)) {
      const sample = ctx.track.sampleAt(s);
      const row: Vector3[] = [];
      for (const [lat, h] of profile) row.push(trackPoint(sample, lat, h, new Vector3()));
      rows.push(row);
      uvV.push(s * 0.11);
    }

    // Soot near the invert, clean concrete over the crown.
    const colors = profile.map(([, h]) => {
      const shade = 0.5 + clamp01((h - BORE_INVERT) / 7.4) * 0.45;
      return new Color(shade, shade * 0.985, shade * 0.95);
    });
    const uvU = profile.map((_, i) => (i / profile.length) * 3.6);
    if (rows.length > 1) bore.addSweep(rows, colors, uvV, uvU, false);

    const boreMesh = bore.toMesh(getTunnelMaterial(), true, 'tunnel-bore');
    if (boreMesh) {
      boreMesh.receiveShadow = true;
      ctx.group.add(boreMesh);
    }

    // Lining segment rings, standing a little proud of the bore.
    const ringColor = new Color(0.58, 0.575, 0.55);
    for (let s = Math.ceil(from / 9) * 9; s < to; s += 9) {
      const ringRows: Vector3[][] = [];
      const ringV: number[] = [];
      for (const rs of [s - 0.16, s + 0.16]) {
        const sample = ctx.track.sampleAt(rs);
        const row: Vector3[] = [];
        for (const [lat, h] of profile) {
          row.push(trackPoint(sample, lat * 1.014, h > 0 ? h + 0.07 : h, new Vector3()));
        }
        ringRows.push(row);
        ringV.push(rs * 0.5);
      }
      rings.addSweep(ringRows, ringColor, ringV, uvU, false);
    }
    const ringMesh = rings.toMesh(getTunnelMaterial(), true, 'tunnel-rings');
    if (ringMesh) ctx.group.add(ringMesh);

    buildTunnelCap(ctx, tunnel, from, to);

    for (const [portalS, dir] of [
      [tunnel.sStart, 1],
      [tunnel.sEnd, -1],
    ] as [number, number][]) {
      if (portalS < ctx.sStart || portalS >= ctx.sEnd) continue;
      buildPortal(ctx, tunnel, portalS, dir);
    }

    // Lighting: a lamp on the cable shelf side every twenty metres.
    const lampMaterial = getLampMaterial();
    const bracket = new MeshBuilder();
    const bracketColor = new Color(0.4, 0.4, 0.38);
    const matrix = new Matrix4();
    for (let s = Math.ceil(from / 20) * 20; s < to; s += 20) {
      const sample = ctx.track.sampleAt(s);
      const lamp = new Mesh(unitCylinder(6), lampMaterial);
      trackMatrix(sample, -(BORE_RADIUS - 0.55), 4.3, matrix, 0, new Vector3(0.26, 0.12, 1.0));
      lamp.applyMatrix4(matrix);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      ctx.group.add(lamp);
      trackMatrix(sample, -(BORE_RADIUS - 0.28), 4.42, matrix, 0, new Vector3(0.5, 0.09, 0.12));
      bracket.add(unitBox(), matrix, bracketColor);
    }
    const bracketMesh = bracket.toMesh(metalMaterial(), false, 'tunnel-brackets');
    if (bracketMesh) ctx.group.add(bracketMesh);
  }
}

let lampMaterialSingleton: MeshBasicMaterial | null = null;
function getLampMaterial(): MeshBasicMaterial {
  if (!lampMaterialSingleton) lampMaterialSingleton = new MeshBasicMaterial({ color: 0xffe6b0 });
  return lampMaterialSingleton;
}

const scratchA = new Vector3();
const scratchB = new Vector3();
