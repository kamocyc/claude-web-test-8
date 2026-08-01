import { BufferAttribute, BufferGeometry, Color, Matrix4, Mesh, Vector3 } from 'three';
import { InstanceCollector, MeshBuilder, addConstantAttribute } from './MeshBuilder';
import {
  asphaltMaterial,
  broadleafMaterial,
  coniferMaterial,
  concreteMaterial,
  crossCards,
  facadeMaterial,
  gableRoof,
  grassMaterial,
  hipRoof,
  makeInstanced,
  mergeGeometries,
  metalMaterial,
  paddyMaterial,
  plainMaterial,
  roofMaterial,
  sidingMaterial,
  taperedCylinder,
  trunkMaterial,
  unitBox,
  unitCone,
  unitCylinder,
} from './Prefabs';
import { blendedAttr, BIOME_INDEX, dominantBiome } from '../world/Biome';
import { trackMatrix } from '../world/TrackFrame';
import { createWaterMaterial } from '../materials/WaterMaterial';
import { textures } from '../materials/TextureFactory';
import { clamp01, lerp } from '../core/MathUtils';
import type { ChunkContext } from '../world/ChunkContext';
import type { TrackSample } from '../world/TrackPath';

/**
 * Everything that lives beside the line: forests, fields, houses, towns,
 * roads, canals and the small clutter that makes a lineside look inhabited.
 *
 * Scatter is done in track space (chainage plus lateral offset) which keeps
 * density constant along the route and makes it trivial to keep the four-foot
 * clear, then projected onto the terrain field so nothing floats.
 */

interface Placement {
  sample: TrackSample;
  lateral: number;
  x: number;
  y: number;
  z: number;
}

const scratchVec = new Vector3();

function place(ctx: ChunkContext, s: number, lateral: number): Placement | null {
  const sample = ctx.track.sampleAt(s);
  const rx = -Math.sin(sample.heading);
  const rz = Math.cos(sample.heading);
  const x = sample.x + rx * lateral;
  const z = sample.z + rz * lateral;
  const y = ctx.field.ground(sample, lateral, x, z);
  if (!Number.isFinite(y)) return null;
  return { sample, lateral, x, y, z };
}

/** Lateral offset with more samples further out, mirrored to both sides. */
function scatterLateral(ctx: ChunkContext, min: number, max: number): number {
  const t = Math.pow(ctx.rng.next(), 0.62);
  const side = ctx.rng.chance(0.5) ? -1 : 1;
  return side * lerp(min, max, t);
}

let coniferCrownGeo: BufferGeometry | null = null;
function coniferCrown(): BufferGeometry {
  if (!coniferCrownGeo) {
    const parts: BufferGeometry[] = [];
    const tiers = [
      { y: 0.0, r: 1.0, h: 0.5 },
      { y: 0.32, r: 0.78, h: 0.44 },
      { y: 0.62, r: 0.52, h: 0.42 },
    ];
    for (const tier of tiers) {
      const cone = unitCone(7).clone();
      cone.scale(tier.r, tier.h, tier.r);
      cone.translate(0, tier.y, 0);
      parts.push(cone);
    }
    coniferCrownGeo = mergeGeometries(parts);
  }
  return coniferCrownGeo;
}

/** Trees, in two species groups, plus lineside scrub. */
export function buildVegetation(ctx: ChunkContext): void {
  const trunks = new InstanceCollector();
  const conifers = new InstanceCollector();
  const broadleaves = new InstanceCollector();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();

  const attempts = Math.round(560 * ctx.profile.sceneryDensity);
  for (let i = 0; i < attempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 11, 520);
    const p = place(ctx, s, lateral);
    if (!p) continue;
    if (p.y < 0.8) continue; // in the water
    if (p.sample.structure !== 0 && Math.abs(lateral) < 30) continue;
    if (p.sample.stationZone > 0.35 && Math.abs(lateral) < 55) continue;

    const density = blendedAttr(p.sample.weights, 'treeDensity');
    // Woodland grows in patches rather than evenly.
    const patch = ctx.field.noise.scatter.fbm(p.x * 0.0035, p.z * 0.0035, 3) * 0.5 + 0.5;
    const chance = clamp01(density * (0.18 + patch * 1.05)) * 0.85;
    if (!ctx.rng.chance(chance)) continue;

    const mountainish =
      p.sample.weights[BIOME_INDEX.mountain] + p.sample.weights[BIOME_INDEX.forest] * 0.7;
    const conifer = ctx.rng.chance(clamp01(0.2 + mountainish * 0.75));

    const height = conifer ? ctx.rng.range(9, 21) : ctx.rng.range(5.5, 13);
    const trunkRadius = height * ctx.rng.range(0.016, 0.028);
    const lean = ctx.rng.range(-0.05, 0.05);

    scale.set(trunkRadius * 2, height * (conifer ? 0.42 : 0.55), trunkRadius * 2);
    trackMatrix(p.sample, lateral, p.y - p.sample.y, matrix, ctx.rng.range(0, 6.28), scale);
    matrix.multiply(new Matrix4().makeRotationZ(lean));
    color.setRGB(0.55, 0.45, 0.36).multiplyScalar(ctx.rng.range(0.8, 1.2));
    trunks.push(matrix, color);

    const crownHeight = conifer ? height : height * 0.62;
    const crownWidth = conifer ? height * 0.42 : height * ctx.rng.range(0.65, 0.95);
    const baseY = p.y - p.sample.y + (conifer ? height * 0.16 : height * 0.42);
    scale.set(crownWidth, crownHeight, crownWidth);
    trackMatrix(p.sample, lateral, baseY, matrix, ctx.rng.range(0, 6.28), scale);

    const seasonal = ctx.field.noise.patches.fbm(p.x * 0.0008, p.z * 0.0008, 2);
    if (conifer) {
      color.setRGB(0.20, 0.36, 0.17).multiplyScalar(ctx.rng.range(0.8, 1.28));
      color.offsetHSL(seasonal * 0.03, 0, 0);
      conifers.push(matrix, color);
    } else {
      color.setRGB(0.42, 0.60, 0.30).multiplyScalar(ctx.rng.range(0.75, 1.3));
      color.offsetHSL(seasonal * 0.06, seasonal * 0.1, 0);
      broadleaves.push(matrix, color);
    }
  }

  const trunkMesh = makeInstanced(taperedCylinder(0.55, 6), trunkMaterial(), trunks, {
    castShadow: true,
    name: 'trunks',
  });
  if (trunkMesh) ctx.group.add(trunkMesh);

  const coniferMesh = makeInstanced(coniferCrown(), coniferMaterial(), conifers, {
    castShadow: true,
    name: 'conifers',
  });
  if (coniferMesh) ctx.group.add(coniferMesh);

  const broadleafMesh = makeInstanced(crossCards(3), broadleafMaterial(), broadleaves, {
    castShadow: true,
    name: 'broadleaves',
  });
  if (broadleafMesh) ctx.group.add(broadleafMesh);
}

/** Grass tufts and weeds along the cess, only close to the camera. */
export function buildGroundCover(ctx: ChunkContext): void {
  if (!ctx.profile.grass || !ctx.detailed) return;
  const tufts = new InstanceCollector();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();

  const attempts = Math.round(520 * ctx.profile.sceneryDensity);
  for (let i = 0; i < attempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 6.2, 46);
    const p = place(ctx, s, lateral);
    if (!p || p.y < 0.4) continue;
    if (p.sample.structure !== 0) continue;
    const shrub = blendedAttr(p.sample.weights, 'shrubDensity');
    if (!ctx.rng.chance(clamp01(shrub * 0.85))) continue;
    const size = ctx.rng.range(0.5, 1.5);
    scale.set(size * 1.5, size, size * 1.5);
    trackMatrix(p.sample, lateral, p.y - p.sample.y, matrix, ctx.rng.range(0, 6.28), scale);
    const shade = ctx.rng.range(0.65, 1.25);
    color.setRGB(0.48 * shade, 0.62 * shade, 0.26 * shade);
    tufts.push(matrix, color);
  }

  const mesh = makeInstanced(crossCards(2), grassMaterial(), tufts, { name: 'grass' });
  if (mesh) ctx.group.add(mesh);
}

type BuildingKind = 'house' | 'farmhouse' | 'shophouse' | 'block' | 'tower' | 'warehouse';

/** Towns, villages and industrial estates. */
export function buildBuildings(ctx: ChunkContext): void {
  const bodies = new Map<string, InstanceCollector>();
  const roofs = new InstanceCollector();
  const hipRoofs = new InstanceCollector();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();

  const collector = (key: string): InstanceCollector => {
    let c = bodies.get(key);
    if (!c) {
      c = new InstanceCollector();
      bodies.set(key, c);
    }
    return c;
  };

  // Buildings in a neighbourhood share an orientation, as if on a street grid.
  const gridAngle = ctx.field.noise.patches.sample(ctx.sStart * 0.0008, 12.5) * Math.PI;

  const attempts = Math.round(60 * ctx.profile.sceneryDensity);
  for (let i = 0; i < attempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 22, 300);
    const p = place(ctx, s, lateral);
    if (!p || p.y < 1.2) continue;
    if (p.sample.structure !== 0 && Math.abs(lateral) < 40) continue;

    const density = blendedAttr(p.sample.weights, 'buildingDensity');
    const cluster = ctx.field.noise.scatter.fbm(p.x * 0.0022 + 40, p.z * 0.0022, 3) * 0.5 + 0.5;
    if (!ctx.rng.chance(clamp01(density * (0.25 + cluster * 1.15)) * 0.8)) continue;

    const biomeId = dominantBiome(p.sample.weights);
    const primary = blendedAttr(p.sample.weights, 'buildingDensity');
    const kind = pickBuildingKind(ctx, biomeId, primary, cluster);

    const yaw = gridAngle + (ctx.rng.chance(0.5) ? 0 : Math.PI / 2) + ctx.rng.range(-0.06, 0.06);
    const baseY = p.y - p.sample.y - 0.25;

    switch (kind) {
      case 'house': {
        const w = ctx.rng.range(6, 9.5);
        const d = ctx.rng.range(6.5, 11);
        const h = ctx.rng.chance(0.45) ? ctx.rng.range(5.4, 6.8) : ctx.rng.range(2.9, 3.4);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setHSL(ctx.rng.range(0.06, 0.15), ctx.rng.range(0.03, 0.16), ctx.rng.range(0.62, 0.88));
        collector('siding').push(matrix, color);
        scale.set(w + 0.9, ctx.rng.range(1.5, 2.4), d + 0.9);
        trackMatrix(p.sample, lateral, baseY + h, matrix, yaw, scale);
        color.setHSL(ctx.rng.range(0.55, 0.65), ctx.rng.range(0.06, 0.3), ctx.rng.range(0.2, 0.42));
        roofs.push(matrix, color);
        break;
      }
      case 'farmhouse': {
        const w = ctx.rng.range(9, 14);
        const d = ctx.rng.range(7, 11);
        const h = ctx.rng.range(3.0, 4.0);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setHSL(0.09, 0.07, ctx.rng.range(0.68, 0.9));
        collector('siding').push(matrix, color);
        scale.set(w + 1.8, ctx.rng.range(2.6, 3.8), d + 1.8);
        trackMatrix(p.sample, lateral, baseY + h, matrix, yaw, scale);
        color.setHSL(0.03, 0.12, ctx.rng.range(0.16, 0.3));
        hipRoofs.push(matrix, color);
        break;
      }
      case 'shophouse': {
        const w = ctx.rng.range(6, 10);
        const d = ctx.rng.range(9, 14);
        const h = ctx.rng.range(7, 11);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.8, 1.05));
        collector(`facade${ctx.rng.int(0, 4)}`).push(matrix, color);
        break;
      }
      case 'block': {
        const w = ctx.rng.range(12, 22);
        const d = ctx.rng.range(12, 22);
        const h = ctx.rng.range(11, 28);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.78, 1.06));
        collector(`facade${ctx.rng.int(0, 4)}`).push(matrix, color);
        // Roof-top plant.
        scale.set(w * 0.3, 1.8, d * 0.3);
        trackMatrix(p.sample, lateral, baseY + h, matrix, yaw, scale);
        collector('concrete').push(matrix, new Color(0.72, 0.72, 0.7));
        break;
      }
      case 'tower': {
        const w = ctx.rng.range(14, 22);
        const d = ctx.rng.range(14, 22);
        const h = ctx.rng.range(30, 68);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.8, 1.04));
        collector(`facade${ctx.rng.int(0, 4)}`).push(matrix, color);
        scale.set(w * 0.55, 3.2, d * 0.55);
        trackMatrix(p.sample, lateral, baseY + h, matrix, yaw, scale);
        collector('concrete').push(matrix, new Color(0.66, 0.66, 0.65));
        break;
      }
      case 'warehouse': {
        const w = ctx.rng.range(14, 28);
        const d = ctx.rng.range(11, 20);
        const h = ctx.rng.range(6, 9.5);
        scale.set(w, h, d);
        trackMatrix(p.sample, lateral, baseY, matrix, yaw, scale);
        color.setRGB(0.72, 0.75, 0.78).multiplyScalar(ctx.rng.range(0.85, 1.15));
        collector('metal').push(matrix, color);
        scale.set(w + 0.7, 0.5, d + 0.7);
        trackMatrix(p.sample, lateral, baseY + h, matrix, yaw, scale);
        collector('metal').push(matrix, color.clone().multiplyScalar(0.85));
        break;
      }
    }
  }

  for (const [key, c] of bodies) {
    let material;
    if (key === 'siding') material = sidingMaterial();
    else if (key === 'metal') material = metalMaterial();
    else if (key === 'concrete') material = concreteMaterial();
    else material = facadeMaterial(Number(key.replace('facade', '')));
    const mesh = makeInstanced(unitBox(), material, c, {
      castShadow: true,
      receiveShadow: true,
      name: `buildings-${key}`,
    });
    if (mesh) ctx.group.add(mesh);
  }

  const roofMesh = makeInstanced(gableRoof(), roofMaterial(), roofs, {
    castShadow: true,
    name: 'roofs',
  });
  if (roofMesh) ctx.group.add(roofMesh);
  const hipMesh = makeInstanced(hipRoof(), roofMaterial(), hipRoofs, {
    castShadow: true,
    name: 'hip-roofs',
  });
  if (hipMesh) ctx.group.add(hipMesh);
}

function pickBuildingKind(
  ctx: ChunkContext,
  biomeId: string,
  density: number,
  cluster: number,
): BuildingKind {
  switch (biomeId) {
    case 'city':
      if (cluster > 0.72 && ctx.rng.chance(0.35)) return 'tower';
      return ctx.rng.chance(0.62) ? 'block' : 'shophouse';
    case 'suburb':
      if (ctx.rng.chance(0.14)) return 'block';
      if (ctx.rng.chance(0.16)) return 'shophouse';
      return ctx.rng.chance(0.1) ? 'warehouse' : 'house';
    case 'farmland':
    case 'riverside':
      return ctx.rng.chance(0.24) ? 'warehouse' : 'farmhouse';
    case 'coast':
      return ctx.rng.chance(0.2) ? 'warehouse' : 'house';
    default:
      void density;
      return 'farmhouse';
  }
}

/** A road running alongside the line, and the poles that follow it. */
export function buildRoads(ctx: ChunkContext): void {
  const first = ctx.samples[0];
  const roadDensity = blendedAttr(first.weights, 'roadDensity');
  if (roadDensity < 0.42) return;

  const side = ctx.field.noise.patches.sample(ctx.sStart * 0.0004, 88.2) > 0 ? 1 : -1;
  const builder = new MeshBuilder();
  const rows: Vector3[][] = [];
  const uvV: number[] = [];
  const centreLat = side * (26 + ctx.field.noise.hills.sample(ctx.sStart * 0.001, 4.4) * 9);
  const halfWidth = roadDensity > 1.2 ? 6 : 3.6;

  for (let i = 0; i < ctx.samples.length; i += 2) {
    const sample = ctx.samples[i];
    const row: Vector3[] = [];
    for (const off of [-halfWidth, -halfWidth * 0.92, halfWidth * 0.92, halfWidth]) {
      const lat = centreLat + off;
      const rx = -Math.sin(sample.heading);
      const rz = Math.cos(sample.heading);
      const x = sample.x + rx * lat;
      const z = sample.z + rz * lat;
      const y = ctx.field.ground(sample, lat, x, z) + 0.08;
      row.push(new Vector3(x, y, z));
    }
    rows.push(row);
    uvV.push(sample.s * 0.09);
  }
  if (rows.length < 2) return;
  builder.addSweep(rows, new Color(0.62, 0.62, 0.63), uvV, [0, 0.05, 0.95, 1]);

  const mesh = builder.toMesh(asphaltMaterial(), true, 'road');
  if (mesh) {
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }

  // Utility poles and their wires.
  const poles = new InstanceCollector();
  const wires = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const poleColor = new Color(0.62, 0.6, 0.56);
  const spacing = 38;
  const poleLat = centreLat + side * (halfWidth + 1.6);
  let previous: Vector3 | null = null;
  for (let s = Math.ceil(ctx.sStart / spacing) * spacing; s <= ctx.sEnd; s += spacing) {
    const p = place(ctx, s, poleLat);
    if (!p) continue;
    scale.set(0.28, 9.5, 0.28);
    trackMatrix(p.sample, poleLat, p.y - p.sample.y, matrix, 0, scale);
    poles.push(matrix, poleColor);
    scale.set(1.8, 0.12, 0.12);
    trackMatrix(p.sample, poleLat, p.y - p.sample.y + 8.6, matrix, 0, scale);
    wires.add(unitBox(), matrix, poleColor);

    const top = new Vector3(p.x, p.y + 9.0, p.z);
    if (previous) {
      const mid = previous.clone().add(top).multiplyScalar(0.5);
      mid.y -= 0.55;
      addWire(wires, previous, mid, top, new Color(0.12, 0.12, 0.12));
    }
    previous = top;
  }

  const poleMesh = makeInstanced(unitCylinder(6), concreteMaterial(), poles, {
    castShadow: true,
    name: 'poles',
  });
  if (poleMesh) ctx.group.add(poleMesh);
  const wireMesh = wires.toMesh(plainMaterial(), true, 'wires');
  if (wireMesh) ctx.group.add(wireMesh);
}

/** A sagging wire drawn as a thin quadratic strip between two poles. */
function addWire(builder: MeshBuilder, a: Vector3, mid: Vector3, b: Vector3, color: Color): void {
  const steps = 6;
  const r = 0.035;
  const rows: Vector3[][] = [];
  const uvV: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = quadratic(a, mid, b, t);
    rows.push([
      new Vector3(p.x - r, p.y + r, p.z),
      new Vector3(p.x + r, p.y + r, p.z),
      new Vector3(p.x + r, p.y - r, p.z),
      new Vector3(p.x - r, p.y - r, p.z),
    ]);
    uvV.push(t);
  }
  builder.addSweep(rows, color, uvV, [0, 0.25, 0.5, 0.75], true);
}

function quadratic(a: Vector3, b: Vector3, c: Vector3, t: number): Vector3 {
  const it = 1 - t;
  return scratchVec.set(
    it * it * a.x + 2 * it * t * b.x + t * t * c.x,
    it * it * a.y + 2 * it * t * b.y + t * t * c.y,
    it * it * a.z + 2 * it * t * b.z + t * t * c.z,
  );
}

/**
 * Rice paddies: a patchwork of flooded and planted fields with earth levees,
 * the signature landscape of rural Japan.
 */
export function buildFields(ctx: ChunkContext): void {
  const first = ctx.samples[Math.floor(ctx.samples.length / 2)];
  const paddyWeight = blendedAttr(first.weights, 'paddy');
  if (paddyWeight < 0.12) return;

  const planted = new MeshBuilder();
  const flooded = new MeshBuilder();
  const levees = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const leveeColor = new Color(0.42, 0.36, 0.26);
  const white = new Color(1, 1, 1);

  const fieldLength = 22;
  const fieldWidth = 17;
  const season = ctx.field.noise.patches.sample(ctx.sStart * 0.0004, 3.3) * 0.5 + 0.5;

  for (let sIdx = 0; ; sIdx++) {
    const s0 = ctx.sStart + sIdx * fieldLength;
    if (s0 >= ctx.sEnd) break;
    for (let side = -1; side <= 1; side += 2) {
      for (let lane = 0; lane < 9; lane++) {
        const lat = side * (24 + lane * fieldWidth);
        const centreS = s0 + fieldLength * 0.5;
        const p = place(ctx, centreS, lat);
        if (!p) continue;
        if (p.y < 1.0) continue;
        if (p.sample.structure !== 0) continue;
        const weight = blendedAttr(p.sample.weights, 'paddy');
        if (!ctx.rng.chance(clamp01(weight * 1.05))) continue;
        // Slope check: paddies only occupy flat ground.
        const pa = place(ctx, s0, lat - fieldWidth * 0.5);
        const pb = place(ctx, s0 + fieldLength, lat + fieldWidth * 0.5);
        if (!pa || !pb) continue;
        if (Math.abs(pa.y - pb.y) > 1.6) continue;

        const level = (p.y + pa.y + pb.y) / 3;
        const isFlooded = ctx.rng.chance(clamp01(0.55 - season * 0.5) + 0.2);
        const target = isFlooded ? flooded : planted;

        scale.set(fieldWidth - 1.2, 0.06, fieldLength - 1.2);
        trackMatrix(p.sample, lat, level - p.sample.y + (isFlooded ? 0.16 : 0.1), matrix, 0, scale);
        target.add(unitBox(), matrix, white);

        // Levees around the field.
        for (const [dl, ds, w, d] of [
          [-(fieldWidth - 1) * 0.5, 0, 0.6, fieldLength],
          [(fieldWidth - 1) * 0.5, 0, 0.6, fieldLength],
          [0, -(fieldLength - 1) * 0.5, fieldWidth, 0.6],
          [0, (fieldLength - 1) * 0.5, fieldWidth, 0.6],
        ] as [number, number, number, number][]) {
          const sm = ctx.track.sampleAt(centreS + ds);
          scale.set(w, 0.34, d);
          trackMatrix(sm, lat + dl, level - sm.y - 0.02, matrix, 0, scale);
          levees.add(unitBox(), matrix, leveeColor);
        }
      }
    }
  }

  const plantedMesh = planted.toMesh(paddyMaterial(season > 0.5 ? 1 : 0), false, 'paddy');
  if (plantedMesh) {
    plantedMesh.receiveShadow = true;
    ctx.group.add(plantedMesh);
  }
  const leveeMesh = levees.toMesh(plainMaterial(), false, 'levees');
  if (leveeMesh) {
    leveeMesh.receiveShadow = true;
    leveeMesh.castShadow = true;
    ctx.group.add(leveeMesh);
  }
  if (!flooded.isEmpty) {
    const geometry = flooded.toGeometry();
    addConstantAttribute(geometry, 'aDepth', 0.32);
    addConstantAttribute(geometry, 'aFlow', 0);
    const material = createWaterMaterial({
      normalMap: textures.waterNormal(),
      shallow: 0x6d7f66,
      deep: 0x46583f,
      waveScale: 0.1,
      chop: 0.12,
      foam: 0,
      ripple: 0.5,
    });
    ctx.water.register(material);
    const mesh = new Mesh(geometry, material);
    mesh.name = 'paddy-water';
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    ctx.group.add(mesh);
  }
}

/** River crossings and lineside canals, as water surfaces on carved ground. */
export function buildWaterways(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const depths: number[] = [];

  for (const river of ctx.track.rivers) {
    if (river.s < ctx.sStart || river.s >= ctx.sEnd) continue;
    const half = river.width * 0.5;
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    const level = ctx.track.sampleAt(river.s).y - river.bankHeight - 3.0;
    for (let lat = -420; lat <= 420; lat += 30) {
      const s = river.s + lat * Math.tan(river.skew);
      const sample = ctx.track.sampleAt(s);
      const row: Vector3[] = [];
      // Column order runs against the direction of travel so the surface
      // faces up.
      for (const ds of [half, half * 0.55, 0, -half * 0.55, -half]) {
        const sm = ctx.track.sampleAt(s + ds);
        const rx = -Math.sin(sm.heading);
        const rz = Math.cos(sm.heading);
        const x = sm.x + rx * lat;
        const z = sm.z + rz * lat;
        row.push(new Vector3(x, level, z));
        depths.push(Math.max(0.05, level - ctx.field.ground(sm, lat, x, z)));
      }
      void sample;
      rows.push(row);
      uvV.push(lat * 0.02);
    }
    builder.addSweep(rows, new Color(1, 1, 1), uvV, [0, 0.25, 0.5, 0.75, 1]);
  }

  // Lineside canal.
  const canalStrength = ctx.samples[0].riverStrength;
  if (canalStrength > 0.25) {
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    for (let i = 0; i < ctx.samples.length; i += 3) {
      const sample = ctx.samples[i];
      const centre = sample.riverSide * (46 + ctx.field.noise.hills.sample(sample.s * 0.0015, 3.1) * 26);
      const width = 9 + ctx.field.noise.detail.sample(sample.s * 0.004, 7.7) * 5;
      const row: Vector3[] = [];
      for (const off of [-width * 0.42, 0, width * 0.42]) {
        const lat = centre + off;
        const rx = -Math.sin(sample.heading);
        const rz = Math.cos(sample.heading);
        const x = sample.x + rx * lat;
        const z = sample.z + rz * lat;
        const bed = ctx.field.ground(sample, lat, x, z);
        row.push(new Vector3(x, bed + 1.35, z));
        depths.push(1.35);
      }
      rows.push(row);
      uvV.push(sample.s * 0.05);
    }
    if (rows.length > 1) builder.addSweep(rows, new Color(1, 1, 1), uvV, [0, 0.5, 1]);
  }

  if (builder.isEmpty) return;
  const geometry = builder.toGeometry(true);
  const count = geometry.getAttribute('position').count;
  const depthArray = new Float32Array(count);
  for (let i = 0; i < count; i++) depthArray[i] = depths[i] ?? 1;
  geometry.setAttribute('aDepth', new BufferAttribute(depthArray, 1));
  addConstantAttribute(geometry, 'aFlow', 0.35);

  const material = createWaterMaterial({
    normalMap: textures.waterNormal(),
    shallow: 0x3f6a5e,
    deep: 0x1d3a44,
    waveScale: 0.35,
    chop: 0.3,
    foam: 0.7,
    ripple: 0.9,
  });
  ctx.water.register(material);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'waterway';
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  ctx.group.add(mesh);
}

/** Boundary fences, relay cabinets, rocks and other small lineside clutter. */
export function buildLinesideDetail(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const grey = new Color(0.66, 0.66, 0.64);
  const green = new Color(0.32, 0.4, 0.34);

  const first = ctx.samples[0];
  const built = blendedAttr(first.weights, 'buildingDensity');

  // Boundary fence where the line runs through built-up land.
  if (built > 0.4) {
    for (const side of [-1, 1]) {
      const lat = side * 9.4;
      for (let s = ctx.sStart; s < ctx.sEnd; s += 3) {
        const p = place(ctx, s, lat);
        if (!p || p.sample.structure !== 0) continue;
        scale.set(0.07, 1.3, 0.07);
        trackMatrix(p.sample, lat, p.y - p.sample.y, matrix, 0, scale);
        builder.add(unitBox(), matrix, grey);
        scale.set(0.04, 0.04, 3.05);
        trackMatrix(p.sample, lat, p.y - p.sample.y + 1.15, matrix, 0, scale);
        builder.add(unitBox(), matrix, grey);
      }
    }
  }

  // Relay cabinets every few hundred metres.
  for (let s = Math.ceil(ctx.sStart / 180) * 180; s < ctx.sEnd; s += 180) {
    const p = place(ctx, s, -8.4);
    if (!p || p.sample.structure !== 0) continue;
    scale.set(0.9, 1.3, 0.6);
    trackMatrix(p.sample, -8.4, p.y - p.sample.y, matrix, 0, scale);
    builder.add(unitBox(), matrix, green);
  }

  const mesh = builder.toMesh(metalMaterial(), false, 'lineside');
  if (mesh) {
    mesh.castShadow = true;
    ctx.group.add(mesh);
  }

  // Boulders on mountain and coastal sections.
  const rocks = new InstanceCollector();
  const rockColor = new Color();
  const rockAttempts = Math.round(60 * ctx.profile.sceneryDensity);
  for (let i = 0; i < rockAttempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 12, 220);
    const p = place(ctx, s, lateral);
    if (!p) continue;
    const rocky =
      p.sample.weights[BIOME_INDEX.mountain] * 1.2 + p.sample.weights[BIOME_INDEX.coast] * 0.9;
    if (!ctx.rng.chance(clamp01(rocky * 0.5))) continue;
    const size = ctx.rng.range(0.6, 3.4);
    scale.set(size * ctx.rng.range(0.8, 1.6), size * ctx.rng.range(0.5, 1.1), size * ctx.rng.range(0.8, 1.6));
    trackMatrix(p.sample, lateral, p.y - p.sample.y - size * 0.2, matrix, ctx.rng.range(0, 6.28), scale);
    const shade = ctx.rng.range(0.55, 0.95);
    rockColor.setRGB(shade, shade * 0.98, shade * 0.94);
    rocks.push(matrix, rockColor);
  }
  const rockMesh = makeInstanced(unitCone(6), concreteMaterial(), rocks, {
    castShadow: true,
    receiveShadow: true,
    name: 'rocks',
  });
  if (rockMesh) ctx.group.add(rockMesh);
}
