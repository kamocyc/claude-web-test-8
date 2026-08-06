import {
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { MeshBuilder } from './MeshBuilder';
import {
  concreteMaterial,
  corrugatedMaterial,
  hipRoof,
  metalMaterial,
  plainMaterial,
  platformMaterial,
  roofMaterial,
  sidingMaterial,
  tactileMaterial,
  unitBox,
  unitCylinder,
} from './Prefabs';
import { createGlassMaterial } from '../materials/Materials';
import { textures } from '../materials/TextureFactory';
import { trackMatrix, trackPoint } from '../world/TrackFrame';
import { TRACK_SPACING } from '../world/TrackPath';
import type { ChunkContext } from '../world/ChunkContext';
import type { StationInfo } from '../world/TrackPath';

/**
 * Stations.
 *
 * Dimensioned from the Japanese prototype: a 1,100 mm platform - which is why
 * a commuter EMU's floor is level with it and there is only a step across the
 * gap - a coped edge with the yellow warning blocks set in from it, a steel
 * canopy on a single row of columns with the roof cantilevered both ways and
 * drained to a gutter at the back, and the furniture that is on every platform
 * in the country: name boards facing the train, a hanging board and a departure
 * indicator under the canopy, benches turned across the platform, a drinks
 * machine, a waiting shelter and a bin.
 *
 * Heights here are measured from the rail head, the same datum the track and
 * the train use, so the platform edge and the door threshold agree by
 * construction rather than by being tuned against each other.
 */

/** Platform surface above rail head - the JR standard 1,100 mm. */
const PLATFORM_TOP = 1.1;
/** Underside of the platform structure, at formation level. */
const PLATFORM_BASE = -0.95;
/** Track centre to platform edge, leaving the prototype's 85 mm gap. */
const EDGE_CLEARANCE = 1.56;
const PLATFORM_WIDTH = 6.0;
/** Soffit of the canopy above the platform deck. */
const CANOPY_CLEAR = 3.3;

const SLAB = new Color(0.86, 0.85, 0.82);
const COPING = new Color(0.93, 0.92, 0.9);
const STEEL = new Color(0.76, 0.77, 0.78);
const DARK_STEEL = new Color(0.4, 0.42, 0.44);
const TIMBER = new Color(0.52, 0.38, 0.26);

export function buildStations(ctx: ChunkContext): void {
  for (const station of ctx.track.stations) {
    if (station.s < ctx.sStart || station.s >= ctx.sEnd) continue;
    buildStation(ctx, station);
  }
}

/** Every surface a station is made of, grouped by the material that draws it. */
interface Parts {
  concrete: MeshBuilder;
  deck: MeshBuilder;
  tactile: MeshBuilder;
  metal: MeshBuilder;
  sheet: MeshBuilder;
  paint: MeshBuilder;
  walls: MeshBuilder;
  tiles: MeshBuilder;
  glass: MeshBuilder;
}

function buildStation(ctx: ChunkContext, station: StationInfo): void {
  const p: Parts = {
    concrete: new MeshBuilder(),
    deck: new MeshBuilder(),
    tactile: new MeshBuilder(),
    metal: new MeshBuilder(),
    sheet: new MeshBuilder(),
    paint: new MeshBuilder(),
    walls: new MeshBuilder(),
    tiles: new MeshBuilder(),
    glass: new MeshBuilder(),
  };

  const sides = station.platformSide === 0 ? [-1, 1] : [station.platformSide];
  const lineColor = LINE_COLORS[station.index % LINE_COLORS.length];

  for (const side of sides) {
    buildPlatform(ctx, station, p, side);
    buildPlatformFurniture(ctx, station, p, side, lineColor);
  }

  buildNameBoards(ctx, station, sides, lineColor);
  buildStationBuilding(ctx, station, p, sides[0]);
  if (station.hasFootbridge && sides.length > 1) buildFootbridge(ctx, station, p);
  buildStopMarker(ctx, station, p);

  const meshes: [MeshBuilder, MeshStandardMaterial, string][] = [
    [p.concrete, concreteMaterial(), 'platform-structure'],
    [p.deck, platformMaterial(), 'platform-deck'],
    [p.tactile, tactileMaterial(), 'platform-tactile'],
    [p.metal, metalMaterial(), 'station-metal'],
    [p.sheet, corrugatedMaterial(), 'canopy-roof'],
    [p.paint, plainMaterial(), 'station-furniture'],
    [p.walls, sidingMaterial(), 'station-building'],
    [p.tiles, roofMaterial(), 'station-roof'],
  ];
  for (const [builder, material, name] of meshes) {
    const mesh = builder.toMesh(material, false, name);
    if (!mesh) continue;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
  const glassMaterial = createGlassMaterial(0x1a2b33, 0.42);
  glassMaterial.vertexColors = true;
  const glassMesh = p.glass.toMesh(glassMaterial, false, 'station-glass');
  if (glassMesh) {
    glassMesh.userData.ownsMaterial = true;
    ctx.group.add(glassMesh);
  }

  buildLighting(ctx, station, sides);
}

/** Line colours, so consecutive stations on a route look like one railway. */
const LINE_COLORS = [0x0a8f4c, 0xd4531e, 0x1560bd, 0xe0a010, 0x8a3fa0];

// --- the platform itself ----------------------------------------------------

function buildPlatform(ctx: ChunkContext, station: StationInfo, p: Parts, side: number): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const half = station.platformLength * 0.5;
  const trackCentre = side * (TRACK_SPACING / 2);
  const edge = trackCentre + side * EDGE_CLEARANCE;
  const outer = edge + side * PLATFORM_WIDTH;
  const centreLat = (edge + outer) * 0.5;

  const segments = Math.max(8, Math.round(station.platformLength / 5));
  const segLength = station.platformLength / segments;

  for (let i = 0; i < segments; i++) {
    const s = station.s - half + (i + 0.5) * segLength;
    const sample = ctx.track.sampleAt(s);
    const len = segLength + 0.06;

    // Structure: the wall and fill under the deck.
    scale.set(PLATFORM_WIDTH, PLATFORM_TOP - PLATFORM_BASE - 0.08, len);
    trackMatrix(sample, centreLat, PLATFORM_BASE, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, SLAB);

    // Deck, laid on top of the structure.
    scale.set(PLATFORM_WIDTH, 0.08, len);
    trackMatrix(sample, centreLat, PLATFORM_TOP - 0.08, matrix, 0, scale);
    p.deck.add(unitBox(), matrix, new Color(1, 1, 1));

    // Coping: the precast nosing along the edge, which is a different colour
    // from the deck on every platform there is.
    scale.set(0.4, 0.1, len);
    trackMatrix(sample, edge + side * 0.2, PLATFORM_TOP - 0.09, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, COPING);

    // Warning blocks, set 400 mm back from the edge as the guidance requires.
    scale.set(0.6, 0.03, len);
    trackMatrix(sample, edge + side * 0.7, PLATFORM_TOP - 0.005, matrix, 0, scale);
    p.tactile.add(unitBox(), matrix, new Color(1, 1, 1));
  }

  // End walls, and a flight of steps down to the cess at the far end so the
  // platform is something that can be got off rather than a floating slab.
  for (const end of [-1, 1]) {
    const sample = ctx.track.sampleAt(station.s + end * (half + 0.03));
    scale.set(PLATFORM_WIDTH, PLATFORM_TOP - PLATFORM_BASE, 0.12);
    trackMatrix(sample, centreLat, PLATFORM_BASE, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, SLAB);
    // Handrail round the end of the platform.
    for (let i = 0; i <= 4; i++) {
      scale.set(0.06, 1.1, 0.06);
      trackMatrix(
        sample,
        edge + side * (0.3 + (i * (PLATFORM_WIDTH - 0.6)) / 4),
        PLATFORM_TOP,
        matrix, 0, scale,
      );
      p.metal.add(unitBox(), matrix, DARK_STEEL);
    }
    scale.set(PLATFORM_WIDTH - 0.5, 0.07, 0.07);
    trackMatrix(sample, centreLat, PLATFORM_TOP + 1.05, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, DARK_STEEL);
  }

  // Back fence: posts, two rails and an infill panel.
  const fenceCount = Math.round(station.platformLength / 2.4);
  for (let i = 0; i <= fenceCount; i++) {
    const s = station.s - half + (i * station.platformLength) / fenceCount;
    const sample = ctx.track.sampleAt(s);
    scale.set(0.08, 1.5, 0.08);
    trackMatrix(sample, outer - side * 0.12, PLATFORM_TOP, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, DARK_STEEL);
    if (i === fenceCount) continue;
    const span = station.platformLength / fenceCount;
    for (const h of [0.62, 1.44]) {
      scale.set(0.05, 0.05, span);
      trackMatrix(sample, outer - side * 0.12, PLATFORM_TOP + h, matrix, 0, scale);
      p.metal.add(unitBox(), matrix, DARK_STEEL);
    }
    scale.set(0.02, 0.78, span - 0.06);
    trackMatrix(sample, outer - side * 0.12, PLATFORM_TOP + 0.66, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, new Color(0.55, 0.57, 0.58));
  }
}

// --- canopy and platform furniture -----------------------------------------

function buildPlatformFurniture(
  ctx: ChunkContext,
  station: StationInfo,
  p: Parts,
  side: number,
  lineColor: number,
): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const half = station.platformLength * 0.5;
  const trackCentre = side * (TRACK_SPACING / 2);
  const edge = trackCentre + side * EDGE_CLEARANCE;
  const outer = edge + side * PLATFORM_WIDTH;
  const deck = PLATFORM_TOP;

  if (station.hasCanopy) {
    const canopyLength = station.platformLength * 0.66;
    const from = station.s - canopyLength / 2;
    const to = station.s + canopyLength / 2;
    const columnLat = edge + side * 2.7;
    const roofInner = edge - side * 0.5;
    const roofOuter = outer - side * 0.5;
    const innerTop = deck + 3.95;
    const outerTop = deck + 3.62;

    // Columns and their head beam.
    const columns = Math.max(3, Math.round(canopyLength / 5));
    for (let i = 0; i <= columns; i++) {
      const s = from + (i * canopyLength) / columns;
      const sample = ctx.track.sampleAt(s);
      scale.set(0.22, CANOPY_CLEAR + 0.3, 0.22);
      trackMatrix(sample, columnLat, deck, matrix, 0, scale);
      p.metal.add(unitBox(), matrix, STEEL);
      // Base plate.
      scale.set(0.4, 0.06, 0.4);
      trackMatrix(sample, columnLat, deck, matrix, 0, scale);
      p.metal.add(unitBox(), matrix, DARK_STEEL);
      // Rafter across the platform, cantilevered both ways off the column and
      // drawn as a thin sloping slab so it follows the fall of the roof - a
      // box could not, because the roof is not level across the platform.
      const inner = trackPoint(sample, roofInner, innerTop - 0.2, new Vector3());
      const out = trackPoint(sample, roofOuter, outerTop - 0.2, new Vector3());
      const up = trackPoint(sample, roofInner, innerTop - 0.32, new Vector3());
      const up2 = trackPoint(sample, roofOuter, outerTop - 0.32, new Vector3());
      const along = trackPoint(ctx.track.sampleAt(s + 0.09), roofInner, innerTop - 0.2, new Vector3())
        .sub(inner);
      p.metal.addQuad(
        inner.clone().sub(along), out.clone().sub(along),
        out.clone().add(along), inner.clone().add(along),
        DARK_STEEL, [0, 0, 1, 1], side < 0,
      );
      p.metal.addQuad(
        up.clone().sub(along), up2.clone().sub(along),
        up2.clone().add(along), up.clone().add(along),
        DARK_STEEL, [0, 0, 1, 1], side > 0,
      );
    }
    // Longitudinal head beam over the columns.
    beamAlong(ctx, p.metal, from, to, columnLat, deck + CANOPY_CLEAR + 0.15, 0.18, 0.34, STEEL);

    // Roof: a shallow single slope draining to a gutter at the back, drawn as
    // a swept slab so it follows the curve of the platform.
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    const steps = Math.max(4, Math.round(canopyLength / 4));
    for (let i = 0; i <= steps; i++) {
      const s = from + (i * canopyLength) / steps;
      const sample = ctx.track.sampleAt(s);
      rows.push([
        trackPoint(sample, roofInner, innerTop, new Vector3()),
        trackPoint(sample, roofOuter, outerTop, new Vector3()),
        trackPoint(sample, roofOuter, outerTop - 0.12, new Vector3()),
        trackPoint(sample, roofInner, innerTop - 0.12, new Vector3()),
      ]);
      uvV.push(s * 0.35);
    }
    p.sheet.addSweep(rows, new Color(0.86, 0.88, 0.9), uvV, [0, 1.6, 1.7, 3.3], true);

    // Fascia along the platform edge and the gutter at the back.
    beamAlong(ctx, p.sheet, from, to, roofInner, innerTop - 0.34, 0.09, 0.3, new Color(0.8, 0.82, 0.84));
    beamAlong(ctx, p.metal, from, to, roofOuter, outerTop - 0.28, 0.22, 0.2, new Color(0.7, 0.72, 0.74));
    // Downpipes on every second column.
    for (let i = 0; i <= columns; i += 2) {
      const sample = ctx.track.sampleAt(from + (i * canopyLength) / columns);
      const pipe = new Matrix4();
      trackMatrix(sample, roofOuter, deck, pipe, 0, new Vector3(0.11, outerTop - deck - 0.3, 0.11));
      p.metal.add(unitCylinder(8), pipe, new Color(0.72, 0.73, 0.74));
    }

    // Hanging name boards and the departure indicator under the canopy.
    for (const offset of [-canopyLength * 0.3, canopyLength * 0.3]) {
      hangingBoard(ctx, p, station, station.s + offset, edge + side * 1.6, deck, lineColor);
    }
    departureBoard(ctx, p, station, side, station.s - canopyLength * 0.42, edge + side * 1.6, deck);
    platformNumber(ctx, p, side, station.s + canopyLength * 0.42, edge + side * 1.6, deck, lineColor);
  } else {
    // A country halt gets a waiting shelter instead: three walls, a glazed
    // front, a bench inside and a monopitch roof.
    const sample = ctx.track.sampleAt(station.s);
    const lat = outer - side * 1.9;
    scale.set(3.2, 0.12, 4.4);
    trackMatrix(sample, lat, deck, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, SLAB);
    scale.set(0.14, 2.5, 4.4);
    trackMatrix(sample, outer - side * 0.4, deck, matrix, 0, scale);
    p.walls.add(unitBox(), matrix, new Color(0.88, 0.87, 0.83));
    for (const end of [-1, 1]) {
      scale.set(3.2, 2.5, 0.14);
      trackMatrix(ctx.track.sampleAt(station.s + end * 2.15), lat, deck, matrix, 0, scale);
      p.walls.add(unitBox(), matrix, new Color(0.88, 0.87, 0.83));
    }
    scale.set(0.1, 1.5, 4.1);
    trackMatrix(sample, lat - side * 1.5, deck + 0.9, matrix, 0, scale);
    p.glass.add(unitBox(), matrix, new Color(0.5, 0.6, 0.64));
    scale.set(3.9, 0.16, 5.0);
    trackMatrix(sample, lat, deck + 2.5, matrix, 0, scale);
    p.sheet.add(unitBox(), matrix, new Color(0.68, 0.7, 0.72));
    bench(p, ctx, station.s, lat + side * 0.7, deck, side, 3.4);
  }

  // Benches, turned across the platform. Japanese platforms have been
  // rearranging them that way for years: someone who has had a drink sits down
  // facing the wall rather than falling forwards onto the track.
  for (const offset of [-half * 0.55, half * 0.1, half * 0.62]) {
    bench(p, ctx, station.s + offset, outer - side * 1.5, deck, side, 1.7);
  }

  // Drinks machines and a bin: the two things on every platform in Japan.
  const kioskSample = ctx.track.sampleAt(station.s + half * 0.32);
  for (const [i, colour] of [[0, 0x9b1c18], [1, 0x134a8f]] as [number, number][]) {
    scale.set(0.85, 1.85, 1.15);
    trackMatrix(
      ctx.track.sampleAt(station.s + half * 0.32 + i * 1.25),
      outer - side * 0.85, deck, matrix, 0, scale,
    );
    p.paint.add(unitBox(), matrix, new Color(colour));
    // Lit product window and the delivery flap below it.
    scale.set(0.06, 0.95, 0.95);
    trackMatrix(
      ctx.track.sampleAt(station.s + half * 0.32 + i * 1.25),
      outer - side * 1.29, deck + 0.72, matrix, 0, scale,
    );
    p.paint.add(unitBox(), matrix, new Color(0.9, 0.9, 0.86));
    scale.set(0.07, 0.22, 0.8);
    trackMatrix(
      ctx.track.sampleAt(station.s + half * 0.32 + i * 1.25),
      outer - side * 1.3, deck + 0.3, matrix, 0, scale,
    );
    p.paint.add(unitBox(), matrix, new Color(0.2, 0.2, 0.22));
  }
  scale.set(0.6, 0.9, 0.6);
  trackMatrix(kioskSample, outer - side * 2.6, deck, matrix, 0, scale);
  p.metal.add(unitCylinder(10), matrix, new Color(0.5, 0.52, 0.54));

  // Timetable and route map on a frame near the middle.
  const boardSample = ctx.track.sampleAt(station.s - half * 0.3);
  scale.set(0.12, 1.25, 2.2);
  trackMatrix(boardSample, outer - side * 0.55, deck + 1.0, matrix, 0, scale);
  p.paint.add(unitBox(), matrix, new Color(0.92, 0.92, 0.89));
  for (const legOffset of [-0.9, 0.9]) {
    scale.set(0.08, 1.05, 0.08);
    trackMatrix(
      ctx.track.sampleAt(station.s - half * 0.3 + legOffset),
      outer - side * 0.55, deck, matrix, 0, scale,
    );
    p.metal.add(unitBox(), matrix, DARK_STEEL);
  }
}

/** A rectangular beam or rail running along the line between two chainages. */
function beamAlong(
  ctx: ChunkContext,
  builder: MeshBuilder,
  from: number,
  to: number,
  lateral: number,
  height: number,
  width: number,
  depth: number,
  color: Color,
): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const steps = Math.max(2, Math.round((to - from) / 4));
  const span = (to - from) / steps;
  for (let i = 0; i < steps; i++) {
    const sample = ctx.track.sampleAt(from + (i + 0.5) * span);
    scale.set(width, depth, span + 0.04);
    trackMatrix(sample, lateral, height, matrix, 0, scale);
    builder.add(unitBox(), matrix, color);
  }
}

/** A slatted bench, turned across the platform, with a back at the outer end. */
function bench(
  p: Parts,
  ctx: ChunkContext,
  s: number,
  lateral: number,
  deck: number,
  side: number,
  width: number,
): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const sample = ctx.track.sampleAt(s);
  for (let i = 0; i < 3; i++) {
    scale.set(width, 0.05, 0.16);
    trackMatrix(sample, lateral, deck + 0.42, matrix, 0, scale);
    matrix.multiply(new Matrix4().makeTranslation(0, 0, (i - 1) * 0.22 / 0.16));
    p.paint.add(unitBox(), matrix, TIMBER);
  }
  for (let i = 0; i < 3; i++) {
    scale.set(width, 0.16, 0.05);
    trackMatrix(sample, lateral - side * (width / 2 - 0.06), deck + 0.5 + i * 0.2, matrix, 0, scale);
    matrix.multiply(new Matrix4().makeTranslation(0, 0, 0));
    p.paint.add(unitBox(), matrix, TIMBER);
  }
  for (const end of [-1, 1]) {
    scale.set(0.08, 0.42, 0.08);
    trackMatrix(sample, lateral + end * (width / 2 - 0.15), deck, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, DARK_STEEL);
  }
}

// --- signage ----------------------------------------------------------------

/** Board hanging from the canopy, readable from both sides. */
function hangingBoard(
  ctx: ChunkContext,
  p: Parts,
  station: StationInfo,
  s: number,
  lateral: number,
  deck: number,
  lineColor: number,
): void {
  const sample = ctx.track.sampleAt(s);
  const matrix = new Matrix4();
  const scale = new Vector3();
  const height = deck + 2.55;
  for (const rod of [-0.7, 0.7]) {
    scale.set(0.05, 0.75, 0.05);
    trackMatrix(ctx.track.sampleAt(s + rod), lateral, height + 0.32, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, DARK_STEEL);
  }
  const board = new Mesh(
    new PlaneGeometry(2.0, 0.5),
    new MeshStandardMaterial({
      map: textures.stationSign(station.name.ja, station.name.ro, undefined, undefined, lineColor),
      roughness: 0.6,
      metalness: 0,
      side: DoubleSide,
    }),
  );
  const m = new Matrix4();
  trackMatrix(sample, lateral, height, m, Math.PI / 2);
  board.applyMatrix4(m);
  board.matrixAutoUpdate = false;
  board.updateMatrix();
  board.userData.ownsGeometry = true;
  board.userData.ownsMaterial = true;
  ctx.group.add(board);
}

function departureBoard(
  ctx: ChunkContext,
  p: Parts,
  station: StationInfo,
  side: number,
  s: number,
  lateral: number,
  deck: number,
): void {
  const sample = ctx.track.sampleAt(s);
  const matrix = new Matrix4();
  const scale = new Vector3();
  const height = deck + 2.5;
  for (const rod of [-0.85, 0.85]) {
    scale.set(0.05, 0.8, 0.05);
    trackMatrix(ctx.track.sampleAt(s + rod), lateral, height + 0.55, matrix, 0, scale);
    p.metal.add(unitBox(), matrix, DARK_STEEL);
  }
  scale.set(0.16, 0.62, 2.3);
  trackMatrix(sample, lateral, height, matrix, 0, scale);
  p.paint.add(unitBox(), matrix, new Color(0.16, 0.17, 0.19));

  const minutes = Math.round((station.scheduledDeparture / 60) % 60);
  const hours = Math.floor(station.scheduledDeparture / 3600) % 24;
  const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const face = new Mesh(
    new PlaneGeometry(2.1, 0.5),
    new MeshBasicMaterial({
      map: textures.departureBoard(station.name.ja, time),
      side: DoubleSide,
    }),
  );
  const m = new Matrix4();
  trackMatrix(sample, lateral - side * 0.09, height + 0.31, m, Math.PI / 2);
  face.applyMatrix4(m);
  face.matrixAutoUpdate = false;
  face.updateMatrix();
  face.userData.ownsGeometry = true;
  face.userData.ownsMaterial = true;
  ctx.group.add(face);
}

function platformNumber(
  ctx: ChunkContext,
  p: Parts,
  side: number,
  s: number,
  lateral: number,
  deck: number,
  lineColor: number,
): void {
  const sample = ctx.track.sampleAt(s);
  const matrix = new Matrix4();
  const scale = new Vector3();
  const height = deck + 2.6;
  scale.set(0.05, 0.7, 0.05);
  trackMatrix(sample, lateral, height + 0.45, matrix, 0, scale);
  p.metal.add(unitBox(), matrix, DARK_STEEL);
  const face = new Mesh(
    new PlaneGeometry(0.6, 0.6),
    new MeshStandardMaterial({
      map: textures.platformNumber(side < 0 ? 1 : 2, lineColor),
      roughness: 0.6,
      side: DoubleSide,
    }),
  );
  const m = new Matrix4();
  trackMatrix(sample, lateral, height, m, Math.PI / 2);
  face.applyMatrix4(m);
  face.matrixAutoUpdate = false;
  face.updateMatrix();
  face.userData.ownsGeometry = true;
  face.userData.ownsMaterial = true;
  ctx.group.add(face);
}

/** Name boards on posts along the platform, facing the arriving train. */
function buildNameBoards(
  ctx: ChunkContext,
  station: StationInfo,
  sides: number[],
  lineColor: number,
): void {
  const half = station.platformLength * 0.5;
  const previous = ctx.track.stations[station.index - 1];
  const next = ctx.track.stations[station.index + 1];
  const material = new MeshStandardMaterial({
    map: textures.stationSign(
      station.name.ja,
      station.name.ro,
      previous?.name.ja,
      next?.name.ja,
      lineColor,
    ),
    roughness: 0.62,
    metalness: 0,
    side: DoubleSide,
  });
  const geometry = new PlaneGeometry(2.6, 0.65);
  let owner = true;
  for (const side of sides) {
    const lat = side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + 1.1);
    for (const offset of [-half * 0.5, 0, half * 0.5]) {
      const sample = ctx.track.sampleAt(station.s + offset);
      const sign = new Mesh(geometry, material);
      const m = new Matrix4();
      trackMatrix(sample, lat, PLATFORM_TOP + 1.75, m, Math.PI / 2);
      sign.applyMatrix4(m);
      sign.matrixAutoUpdate = false;
      sign.updateMatrix();
      // One owner disposes the shared geometry and material for all of them.
      sign.userData.ownsGeometry = owner;
      sign.userData.ownsMaterial = owner;
      owner = false;
      ctx.group.add(sign);

      // The post it stands on.
      const post = new MeshBuilder();
      const scale = new Vector3(0.09, PLATFORM_TOP + 1.45, 0.09);
      const pm = new Matrix4();
      trackMatrix(sample, lat, 0, pm, 0, scale);
      post.add(unitBox(), pm, DARK_STEEL);
      const postMesh = post.toMesh(metalMaterial(), false, 'sign-post');
      if (postMesh) {
        postMesh.castShadow = true;
        ctx.group.add(postMesh);
      }
    }
  }
}

// --- station building, footbridge and marker --------------------------------

/**
 * The station building, on the outer side of the first platform: a low block
 * with a deep-eaved hipped roof, a glazed frontage under an entrance canopy,
 * and the name over the door.
 */
function buildStationBuilding(
  ctx: ChunkContext,
  station: StationInfo,
  p: Parts,
  side: number,
): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const sample = ctx.track.sampleAt(station.s - station.platformLength * 0.18);
  const lat = side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH + 7);
  const urban = station.biome === 'city' || station.biome === 'suburb';
  const w = urban ? 15 : 11;
  const d = urban ? 11 : 8.5;
  const h = urban ? 8.0 : 4.4;
  const base = PLATFORM_BASE + 0.15;

  // Walls, on a plinth.
  scale.set(w + 0.5, 0.45, d + 0.5);
  trackMatrix(sample, lat, base, matrix, 0, scale);
  p.concrete.add(unitBox(), matrix, new Color(0.68, 0.67, 0.64));
  scale.set(w, h, d);
  trackMatrix(sample, lat, base + 0.45, matrix, 0, scale);
  p.walls.add(unitBox(), matrix, new Color(0.93, 0.91, 0.86));

  // Glazed frontage facing the forecourt, with the entrance in the middle.
  scale.set(0.16, h * 0.5, d * 0.7);
  trackMatrix(sample, lat + side * (w / 2), base + 1.0, matrix, 0, scale);
  p.glass.add(unitBox(), matrix, new Color(0.42, 0.52, 0.58));
  // Entrance canopy over it.
  scale.set(3.4, 0.22, d * 0.8);
  trackMatrix(sample, lat + side * (w / 2 + 1.5), base + 3.4, matrix, 0, scale);
  p.concrete.add(unitBox(), matrix, new Color(0.8, 0.79, 0.76));
  for (const dz of [-1, 1]) {
    scale.set(0.18, 3.4, 0.18);
    trackMatrix(
      ctx.track.sampleAt(station.s - station.platformLength * 0.18 + dz * d * 0.34),
      lat + side * (w / 2 + 2.8), base, matrix, 0, scale,
    );
    p.metal.add(unitBox(), matrix, STEEL);
  }

  // Roof: a hipped roof with a deep overhang, which is what makes a small
  // Japanese station read as one rather than as an office.
  if (urban) {
    scale.set(w + 1.4, 0.9, d + 1.4);
    trackMatrix(sample, lat, base + 0.45 + h, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, new Color(0.72, 0.71, 0.68));
  } else {
    scale.set(w + 2.6, 2.6, d + 2.6);
    trackMatrix(sample, lat, base + 0.45 + h, matrix, 0, scale);
    p.tiles.add(hipRoof(), matrix, new Color(0.24, 0.26, 0.3));
  }

  // Name over the entrance.
  const nameBoard = new Mesh(
    new PlaneGeometry(4.6, 1.0),
    new MeshStandardMaterial({
      map: textures.stationSign(station.name.ja, station.name.ro),
      roughness: 0.65,
      side: DoubleSide,
    }),
  );
  const m = new Matrix4();
  trackMatrix(sample, lat + side * (w / 2 + 0.2), base + h - 0.6, m, side > 0 ? 0 : Math.PI);
  nameBoard.applyMatrix4(m);
  nameBoard.matrixAutoUpdate = false;
  nameBoard.updateMatrix();
  nameBoard.userData.ownsGeometry = true;
  nameBoard.userData.ownsMaterial = true;
  ctx.group.add(nameBoard);

  // Covered walkway from the building back to the platform, and the steps up.
  const linkLat = side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH + 3);
  scale.set(6.5, 0.16, 3.2);
  trackMatrix(sample, linkLat, PLATFORM_TOP + 2.6, matrix, 0, scale);
  p.sheet.add(unitBox(), matrix, new Color(0.74, 0.76, 0.78));
  for (const dz of [-1.3, 1.3]) {
    scale.set(0.16, PLATFORM_TOP + 2.6 - base, 0.16);
    trackMatrix(
      ctx.track.sampleAt(station.s - station.platformLength * 0.18 + dz),
      linkLat + side * 2.9, base, matrix, 0, scale,
    );
    p.metal.add(unitBox(), matrix, STEEL);
  }
  for (let i = 0; i < 6; i++) {
    scale.set(0.34, PLATFORM_TOP - base - i * ((PLATFORM_TOP - base) / 6), 2.6);
    trackMatrix(
      sample,
      side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH) + side * (0.2 + i * 0.34),
      base, matrix, 0, scale,
    );
    p.concrete.add(unitBox(), matrix, new Color(0.78, 0.77, 0.74));
  }
}

/** A covered footbridge over the line, with a stair down to each platform. */
function buildFootbridge(ctx: ChunkContext, station: StationInfo, p: Parts): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const s = station.s + station.platformLength * 0.3;
  const sample = ctx.track.sampleAt(s);
  const deckHeight = PLATFORM_TOP + 6.2;
  const span = (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH) * 2;

  scale.set(span, 0.3, 3.0);
  trackMatrix(sample, 0, deckHeight, matrix, 0, scale);
  p.concrete.add(unitBox(), matrix, new Color(0.8, 0.79, 0.76));
  for (const side of [-1, 1]) {
    scale.set(0.16, 1.9, 3.0);
    trackMatrix(sample, side * (span / 2 - 0.08), deckHeight + 0.3, matrix, 0, scale);
    p.glass.add(unitBox(), matrix, new Color(0.46, 0.55, 0.6));
    // Supports outside the running lines.
    scale.set(0.4, deckHeight - PLATFORM_BASE, 0.4);
    trackMatrix(sample, side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + 1.2), PLATFORM_BASE, matrix, 0, scale);
    p.concrete.add(unitBox(), matrix, new Color(0.76, 0.75, 0.72));
    // Stair down to the platform.
    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      scale.set(1.8, deckHeight - PLATFORM_TOP - t * (deckHeight - PLATFORM_TOP), 0.42);
      trackMatrix(
        ctx.track.sampleAt(s + 2.0 + i * 0.44),
        side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + 3.0),
        PLATFORM_TOP, matrix, 0, scale,
      );
      p.concrete.add(unitBox(), matrix, new Color(0.8, 0.79, 0.76));
    }
  }
  scale.set(span + 0.6, 0.18, 3.6);
  trackMatrix(sample, 0, deckHeight + 2.2, matrix, 0, scale);
  p.sheet.add(unitBox(), matrix, new Color(0.78, 0.8, 0.82));
}

/**
 * Stopping position marker: the plate the driver lines the cab up with. On a
 * Japanese platform it is a small board on a post at the far end, marked with
 * the number of cars it applies to.
 */
function buildStopMarker(ctx: ChunkContext, station: StationInfo, p: Parts): void {
  const matrix = new Matrix4();
  const scale = new Vector3();
  const sample = ctx.track.sampleAt(station.s + station.platformLength * 0.5 - 6);
  const lat = -(TRACK_SPACING / 2) - EDGE_CLEARANCE - 0.55;
  scale.set(0.1, PLATFORM_TOP + 1.5, 0.1);
  trackMatrix(sample, lat, 0, matrix, 0, scale);
  p.metal.add(unitBox(), matrix, new Color(0.9, 0.9, 0.88));
  scale.set(0.05, 0.55, 0.55);
  trackMatrix(sample, lat, PLATFORM_TOP + 0.95, matrix, 0, scale);
  p.paint.add(unitBox(), matrix, new Color(0.96, 0.9, 0.25));
  scale.set(0.07, 0.16, 0.42);
  trackMatrix(sample, lat, PLATFORM_TOP + 1.14, matrix, 0, scale);
  p.paint.add(unitBox(), matrix, new Color(0.14, 0.14, 0.15));
}

// --- lighting ---------------------------------------------------------------

function buildLighting(ctx: ChunkContext, station: StationInfo, sides: number[]): void {
  const lampMaterial = new MeshBasicMaterial({ color: 0xfff0d0 });
  const half = station.platformLength * 0.5;
  for (const side of sides) {
    const lat = side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH * 0.45);
    for (let i = -2; i <= 2; i++) {
      const sample = ctx.track.sampleAt(station.s + i * half * 0.4);
      const lamp = new Mesh(unitBox(), lampMaterial);
      const m = new Matrix4();
      trackMatrix(
        sample, lat,
        PLATFORM_TOP + (station.hasCanopy ? 3.2 : 3.6),
        m, 0, new Vector3(0.34, 0.1, 1.3),
      );
      lamp.applyMatrix4(m);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      lamp.userData.nightOnly = true;
      ctx.group.add(lamp);
    }
  }
}
