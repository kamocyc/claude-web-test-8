import { BufferAttribute, Color, Matrix4, Mesh, Vector3 } from 'three';
import { InstanceCollector, MeshBuilder, addConstantAttribute } from './MeshBuilder';
import {
  asphaltMaterial,
  broadleafCanopy,
  broadleafMaterial,
  coniferCrown,
  coniferMaterial,
  concreteMaterial,
  crossCards,
  facadeMaterial,
  gableRoof,
  grassMaterial,
  hipRoof,
  makeInstanced,
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
import { groundMatrix } from '../world/TrackFrame';
import { canalLevel, canalCentre, canalWidth } from '../world/TerrainField';
import { riverAxis, riverHalfAt, riverLevelAt, riverPoint } from '../world/River';
import { onRoad, roadAt, waterProximity } from '../world/Sites';
import { createWaterMaterial } from '../materials/WaterMaterial';
import { textures } from '../materials/TextureFactory';
import { clamp01, lerp } from '../core/MathUtils';
import type { ChunkContext } from '../world/ChunkContext';
import type { TrackSample } from '../world/TrackPath';

/**
 * Everything that lives beside the line: forests, fields, houses, towns,
 * roads, canals and the small clutter that makes a lineside look inhabited.
 *
 * Candidate positions are chosen in track space (chainage plus lateral offset)
 * which keeps density constant along the route and makes it trivial to keep the
 * four-foot clear. Everything is then *placed* in world space, standing on the
 * terrain: the track frame is rolled by the cant and tilted by the gradient, so
 * an offset of a couple of hundred metres along its right axis lands tens of
 * metres off the ground the height was read from - which is what used to leave
 * whole neighbourhoods hanging in the air over a canted curve.
 */

interface Placement {
  sample: TrackSample;
  lateral: number;
  x: number;
  y: number;
  z: number;
  /** Index hint into the stored samples, for further height queries nearby. */
  hint: number;
}

const scratchVec = new Vector3();

/** Beyond this the world tiles draw the ground, not the track-space corridor. */
const CORRIDOR_REACH = 70;

function place(ctx: ChunkContext, s: number, lateral: number): Placement | null {
  const sample = ctx.track.sampleAt(s);
  const rx = -Math.sin(sample.heading);
  const rz = Math.cos(sample.heading);
  const x = sample.x + rx * lateral;
  const z = sample.z + rz * lateral;
  const hint = ctx.track.sampleIndex(s);
  // Ask for the height the way whichever mesh draws the ground here asks for
  // it. Beside the line that is the corridor, in track space at this chainage;
  // further out it is the tiles, which project the world position back onto
  // the centre line - and on a tight curve those two are not the same place at
  // all. Reading the wrong one is what left a stand of trees hanging twenty
  // metres over the inside of a mountain bend.
  const y =
    Math.abs(lateral) < CORRIDOR_REACH
      ? ctx.field.ground(sample, lateral, x, z)
      : ctx.field.heightAt(x, z, hint).y;
  if (!Number.isFinite(y)) return null;
  return { sample, lateral, x, y, z, hint };
}

/** Ground under a rectangular footprint: the extremes of its four corners. */
function footprint(
  ctx: ChunkContext,
  p: Placement,
  halfW: number,
  halfD: number,
  yaw: number,
): { low: number; high: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let low = p.y;
  let high = p.y;
  for (const [ox, oz] of [
    [-halfW, -halfD],
    [halfW, -halfD],
    [halfW, halfD],
    [-halfW, halfD],
  ]) {
    // Local X is right, local Z is back, matching `groundMatrix`.
    const wx = p.x + c * ox + s * oz;
    const wz = p.z - s * ox + c * oz;
    const { y } = ctx.field.heightAt(wx, wz, p.hint);
    if (y < low) low = y;
    if (y > high) high = y;
  }
  return { low, high };
}

/**
 * World yaw that squares an object to the line.
 *
 * `groundMatrix` puts local +X to the right and local +Z back along the object,
 * the same convention `trackMatrix` uses, so this is the angle at which the two
 * frames agree - lineside furniture that has to line up with the railway
 * without inheriting its cant.
 */
function alignedYaw(heading: number): number {
  return -(heading + Math.PI / 2);
}

/** Lateral offset with more samples further out, mirrored to both sides. */
function scatterLateral(ctx: ChunkContext, min: number, max: number): number {
  const t = Math.pow(ctx.rng.next(), 0.62);
  const side = ctx.rng.chance(0.5) ? -1 : 1;
  return side * lerp(min, max, t);
}

/** Number of crown shapes generated per species, to break up cloning. */
const TREE_VARIANTS = 3;

/** Trees, in two species groups, plus lineside scrub. */
export function buildVegetation(ctx: ChunkContext): void {
  const trunks = new InstanceCollector();
  const conifers = [new InstanceCollector(), new InstanceCollector(), new InstanceCollector()];
  const broadleaves = [new InstanceCollector(), new InstanceCollector(), new InstanceCollector()];
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
    if (onRoad(roadAt(p.sample, ctx.field.noise), lateral, 2.5)) continue;
    if (waterProximity(ctx.field, p.sample, lateral, p.x, p.z, 6) > 0.4) continue;
    if (!ctx.sites.free(p.x, p.z, 2.5)) continue;

    const density = blendedAttr(p.sample.weights, 'treeDensity');
    // Woodland grows in stands with open ground between them, not as an even
    // sprinkle: squaring the patch weight is what separates the two.
    const patch = clamp01(ctx.field.noise.scatter.fbm(p.x * 0.0035, p.z * 0.0035, 3) * 0.5 + 0.5);
    const stand = patch * patch * (3 - 2 * patch);
    const chance = clamp01(density * (0.06 + stand * 1.5)) * 0.9;
    if (!ctx.rng.chance(chance)) continue;

    const mountainish =
      p.sample.weights[BIOME_INDEX.mountain] + p.sample.weights[BIOME_INDEX.forest] * 0.7;
    const conifer = ctx.rng.chance(clamp01(0.2 + mountainish * 0.75));

    const height = conifer ? ctx.rng.range(9, 21) : ctx.rng.range(5.5, 13);
    const trunkRadius = height * ctx.rng.range(0.016, 0.028);
    const lean = ctx.rng.range(-0.05, 0.05);
    const yaw = ctx.rng.range(0, 6.28);

    scale.set(trunkRadius * 2, height * (conifer ? 0.42 : 0.55), trunkRadius * 2);
    groundMatrix(p.x, p.y - 0.25, p.z, yaw, matrix, scale);
    matrix.multiply(new Matrix4().makeRotationZ(lean));
    color.setRGB(0.55, 0.45, 0.36).multiplyScalar(ctx.rng.range(0.8, 1.2));
    trunks.push(matrix, color);

    const crownHeight = conifer ? height : height * 0.62;
    const crownWidth = conifer ? height * 0.42 : height * ctx.rng.range(0.65, 0.95);
    const baseY = p.y + (conifer ? height * 0.16 : height * 0.42);
    scale.set(crownWidth, crownHeight, crownWidth);
    groundMatrix(p.x, baseY, p.z, yaw, matrix, scale);

    const seasonal = ctx.field.noise.patches.fbm(p.x * 0.0008, p.z * 0.0008, 2);
    const variant = ctx.rng.int(0, TREE_VARIANTS - 1);
    if (conifer) {
      color.setRGB(0.14, 0.26, 0.13).multiplyScalar(ctx.rng.range(0.72, 1.35));
      color.offsetHSL(seasonal * 0.03, 0, 0);
      conifers[variant].push(matrix, color);
    } else {
      color.setRGB(0.30, 0.45, 0.21).multiplyScalar(ctx.rng.range(0.7, 1.36));
      color.offsetHSL(seasonal * 0.06, seasonal * 0.12, 0);
      broadleaves[variant].push(matrix, color);
    }
  }

  // Scrub under and around the stands, which is what stops a wood ending in
  // mid air at the trunk line.
  const bushAttempts = Math.round(220 * ctx.profile.sceneryDensity);
  for (let i = 0; i < bushAttempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 13, 260);
    const p = place(ctx, s, lateral);
    if (!p || p.y < 0.8) continue;
    if (p.sample.structure !== 0 && Math.abs(lateral) < 30) continue;
    if (p.sample.stationZone > 0.35 && Math.abs(lateral) < 55) continue;
    if (onRoad(roadAt(p.sample, ctx.field.noise), lateral, 1.5)) continue;
    if (!ctx.sites.free(p.x, p.z, 1.5)) continue;
    const patch = clamp01(ctx.field.noise.scatter.fbm(p.x * 0.0035, p.z * 0.0035, 3) * 0.5 + 0.5);
    const shrubs = blendedAttr(p.sample.weights, 'shrubDensity');
    if (!ctx.rng.chance(clamp01(shrubs * (0.2 + patch * 0.9)) * 0.7)) continue;
    const size = ctx.rng.range(1.1, 2.9);
    scale.set(size * ctx.rng.range(0.9, 1.4), size * 0.8, size * ctx.rng.range(0.9, 1.4));
    groundMatrix(p.x, p.y - 0.15, p.z, ctx.rng.range(0, 6.28), matrix, scale);
    color.setRGB(0.24, 0.36, 0.17).multiplyScalar(ctx.rng.range(0.7, 1.3));
    broadleaves[ctx.rng.int(0, TREE_VARIANTS - 1)].push(matrix, color);
  }

  const trunkMesh = makeInstanced(taperedCylinder(0.55, 6), trunkMaterial(), trunks, {
    castShadow: true,
    name: 'trunks',
  });
  if (trunkMesh) ctx.group.add(trunkMesh);

  for (let v = 0; v < TREE_VARIANTS; v++) {
    const coniferMesh = makeInstanced(coniferCrown(v), coniferMaterial(), conifers[v], {
      castShadow: true,
      name: `conifers-${v}`,
    });
    if (coniferMesh) ctx.group.add(coniferMesh);
    const broadleafMesh = makeInstanced(broadleafCanopy(v), broadleafMaterial(), broadleaves[v], {
      castShadow: true,
      name: `broadleaves-${v}`,
    });
    if (broadleafMesh) ctx.group.add(broadleafMesh);
  }
}

/** Grass tufts and weeds along the cess, only close to the camera. */
export function buildGroundCover(ctx: ChunkContext): void {
  if (!ctx.profile.grass || !ctx.detailed) return;
  const tufts = new InstanceCollector();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();

  const attempts = Math.round(900 * ctx.profile.sceneryDensity);
  for (let i = 0; i < attempts; i++) {
    const s = ctx.rng.range(ctx.sStart, ctx.sEnd);
    const lateral = scatterLateral(ctx, 5.9, 44);
    const p = place(ctx, s, lateral);
    if (!p || p.y < 0.4) continue;
    if (p.sample.structure !== 0) continue;
    if (onRoad(roadAt(p.sample, ctx.field.noise), lateral, 0.5)) continue;
    if (!ctx.sites.free(p.x, p.z, 0.6)) continue;
    const shrub = blendedAttr(p.sample.weights, 'shrubDensity');
    // Weeds grow thickest right at the edge of the ballast, where nothing
    // walks on them and the drainage is good.
    const cess = 1 + 0.9 * (1 - clamp01((Math.abs(lateral) - 6) / 8));
    if (!ctx.rng.chance(clamp01(shrub * 0.8 * cess))) continue;
    // Lineside weeds are knee high, not waist high: oversized tufts read as
    // cardboard cut-outs standing in the grass.
    const size = ctx.rng.range(0.3, 0.95);
    scale.set(size * 1.7, size * ctx.rng.range(0.8, 1.4), size * 1.7);
    groundMatrix(p.x, p.y - 0.05, p.z, ctx.rng.range(0, 6.28), matrix, scale);
    const shade = ctx.rng.range(0.6, 1.3);
    // The odd bleached, seeded head among the green.
    const dry = ctx.rng.chance(0.16) ? 1 : 0;
    color.setRGB(
      lerp(0.34, 0.62, dry) * shade,
      lerp(0.5, 0.58, dry) * shade,
      lerp(0.18, 0.26, dry) * shade,
    );
    tufts.push(matrix, color);
  }

  const mesh = makeInstanced(crossCards(3), grassMaterial(), tufts, { name: 'grass' });
  if (mesh) ctx.group.add(mesh);
}

type BuildingKind = 'house' | 'farmhouse' | 'shophouse' | 'block' | 'tower' | 'warehouse';

/** Plan dimensions and how much fall a plot of each kind will tolerate. */
const KIND_SITE: Record<BuildingKind, { plot: number; fall: number }> = {
  house: { plot: 2.6, fall: 2.4 },
  farmhouse: { plot: 3.4, fall: 2.4 },
  shophouse: { plot: 1.6, fall: 2.0 },
  block: { plot: 3.0, fall: 2.6 },
  tower: { plot: 5.0, fall: 2.6 },
  warehouse: { plot: 3.0, fall: 1.8 },
};

/** Towns, villages and industrial estates. */
export function buildBuildings(ctx: ChunkContext): void {
  const bodies = new Map<string, InstanceCollector>();
  const roofs = new InstanceCollector();
  const hipRoofs = new InstanceCollector();
  const signs = new InstanceCollector();
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
    // Keep the whole plot inside this chunk's stretch of line: chunks are built
    // independently and cannot see each other's claims, so a building that
    // overhangs the join is a building that can be built over.
    const s = ctx.rng.range(ctx.sStart + 24, ctx.sEnd - 24);
    const lateral = scatterLateral(ctx, 22, 300);
    const p = place(ctx, s, lateral);
    if (!p || p.y < 1.2) continue;
    if (p.sample.structure !== 0 && Math.abs(lateral) < 40) continue;

    const density = blendedAttr(p.sample.weights, 'buildingDensity');
    const cluster = ctx.field.noise.scatter.fbm(p.x * 0.0022 + 40, p.z * 0.0022, 3) * 0.5 + 0.5;
    if (!ctx.rng.chance(clamp01(density * (0.25 + cluster * 1.15)) * 0.8)) continue;

    // Nothing is built in the carriageway, in the river or on the flood side of
    // its levee.
    if (onRoad(roadAt(p.sample, ctx.field.noise), lateral, 3)) continue;
    if (waterProximity(ctx.field, p.sample, lateral, p.x, p.z, 22) > 0.25) continue;

    const biomeId = dominantBiome(p.sample.weights);
    const kind = pickBuildingKind(ctx, biomeId, density, cluster);
    const plan = planBuilding(ctx, kind);
    const site = KIND_SITE[kind];

    const yaw = gridAngle + (ctx.rng.chance(0.5) ? 0 : Math.PI / 2) + ctx.rng.range(-0.06, 0.06);
    const radius = Math.hypot(plan.w, plan.d) * 0.5 + site.plot;
    if (!ctx.sites.free(p.x, p.z, radius)) continue;

    // Ground is not level, and a box dropped on the average of it floats at one
    // corner and is buried at the other. Read the plot, refuse anything too
    // steep to build on, stand the building on the high corner and carry the
    // fall on a concrete stem wall - which is how a Japanese house sits on a
    // slope anyway.
    const { low, high } = footprint(ctx, p, plan.w * 0.5, plan.d * 0.5, yaw);
    if (high - low > site.fall) continue;
    ctx.sites.claim(p.x, p.z, radius);

    const baseY = high + 0.1;
    const plinth = baseY - (low - 0.6);
    scale.set(plan.w + 0.55, plinth, plan.d + 0.55);
    groundMatrix(p.x, low - 0.6, p.z, yaw, matrix, scale);
    collector('concrete').push(matrix, new Color(0.63, 0.62, 0.59));

    const put = (w: number, h: number, d: number, y: number, key: string, c: Color): Matrix4 => {
      scale.set(w, h, d);
      groundMatrix(p.x, baseY + y, p.z, yaw, matrix, scale);
      collector(key).push(matrix, c);
      return matrix;
    };

    switch (kind) {
      case 'house': {
        const { w, d, h } = plan;
        color.setHSL(ctx.rng.range(0.06, 0.15), ctx.rng.range(0.03, 0.16), ctx.rng.range(0.62, 0.88));
        put(w, h, d, 0, 'siding', color);
        scale.set(w + 0.9, ctx.rng.range(1.5, 2.4), d + 0.9);
        groundMatrix(p.x, baseY + h, p.z, yaw, matrix, scale);
        color.setHSL(ctx.rng.range(0.55, 0.65), ctx.rng.range(0.06, 0.3), ctx.rng.range(0.2, 0.42));
        roofs.push(matrix, color);
        // Entrance canopy, a balcony on the upper floor, and the block wall
        // that surrounds every Japanese plot.
        scale.set(w * 0.42, 0.16, 1.5);
        groundMatrix(p.x, baseY + 2.25, p.z, yaw, matrix, scale);
        matrix.multiply(new Matrix4().makeTranslation(0, 0, (d * 0.5 + 0.6) / 1.5));
        collector('concrete').push(matrix, new Color(0.62, 0.6, 0.57));
        if (h > 4.5) {
          scale.set(w * 0.8, 1.05, 0.12);
          groundMatrix(p.x, baseY + h * 0.52, p.z, yaw, matrix, scale);
          matrix.multiply(new Matrix4().makeTranslation(0, 0, (d * 0.5 + 0.06) / 0.12));
          collector('concrete').push(matrix, new Color(0.78, 0.77, 0.74));
        }
        if (ctx.rng.chance(0.7)) {
          const wallColor = new Color(0.7, 0.69, 0.65);
          const hw = w * 0.5 + 2.0;
          const hd = d * 0.5 + 2.0;
          for (const [ox, oz, sx, sz] of [
            [-hw, 0, 0.22, hd * 2], [hw, 0, 0.22, hd * 2],
            [0, -hd, hw * 2, 0.22], [0, hd, hw * 2, 0.22],
          ] as [number, number, number, number][]) {
            scale.set(sx, 1.5, sz);
            groundMatrix(p.x, low - 0.2, p.z, yaw, matrix, scale);
            matrix.multiply(new Matrix4().makeTranslation(ox / sx, 0, oz / sz));
            collector('concrete').push(matrix, wallColor);
          }
        }
        break;
      }
      case 'farmhouse': {
        const { w, d, h } = plan;
        color.setHSL(0.09, 0.07, ctx.rng.range(0.68, 0.9));
        put(w, h, d, 0, 'siding', color);
        scale.set(w + 1.8, ctx.rng.range(2.6, 3.8), d + 1.8);
        groundMatrix(p.x, baseY + h, p.z, yaw, matrix, scale);
        color.setHSL(0.03, 0.12, ctx.rng.range(0.16, 0.3));
        hipRoofs.push(matrix, color);
        break;
      }
      case 'shophouse': {
        const { w, d, h } = plan;
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.8, 1.05));
        put(w, h, d, 0, `facade${ctx.rng.int(0, 4)}`, color);
        // Shop front: an awning over the pavement and a signboard standing up
        // the corner of the building.
        put(w + 0.5, 0.3, 1.6, 3.1, 'metal', new Color(0.5, 0.2, 0.18));
        scale.set(0.9, h * 0.55, 0.35);
        groundMatrix(p.x, baseY + h * 0.36, p.z, yaw, matrix, scale);
        matrix.multiply(new Matrix4().makeTranslation((w * 0.5 - 0.6) / 0.9, 0, (d * 0.5 + 0.2) / 0.35));
        signs.push(matrix, new Color().setHSL(ctx.rng.next(), 0.62, 0.52));
        break;
      }
      case 'block': {
        const { w, d, h } = plan;
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.78, 1.06));
        put(w, h, d, 0, `facade${ctx.rng.int(0, 4)}`, color);
        // Roof-top plant behind a parapet, and a water tank on legs.
        put(w * 0.3, 1.8, d * 0.3, h, 'concrete', new Color(0.72, 0.72, 0.7));
        put(w + 0.4, 0.9, d + 0.4, h, 'concrete', new Color(0.76, 0.75, 0.72));
        if (ctx.rng.chance(0.5)) {
          scale.set(2.6, 1.5, 2.0);
          groundMatrix(p.x, baseY + h + 1.9, p.z, yaw, matrix, scale);
          matrix.multiply(new Matrix4().makeTranslation((w * 0.26) / 2.6, 0, (d * 0.26) / 2.0));
          collector('metal').push(matrix, new Color(0.78, 0.78, 0.76));
        }
        break;
      }
      case 'tower': {
        const { w, d, h } = plan;
        color.setRGB(1, 1, 1).multiplyScalar(ctx.rng.range(0.8, 1.04));
        put(w, h, d, 0, `facade${ctx.rng.int(0, 4)}`, color);
        put(w * 0.55, 3.2, d * 0.55, h, 'concrete', new Color(0.66, 0.66, 0.65));
        put(w + 0.5, 1.1, d + 0.5, h, 'concrete', new Color(0.7, 0.7, 0.69));
        put(0.24, 6.5, 0.24, h + 3.2, 'metal', new Color(0.8, 0.5, 0.45));
        break;
      }
      case 'warehouse': {
        const { w, d, h } = plan;
        color.setRGB(0.72, 0.75, 0.78).multiplyScalar(ctx.rng.range(0.85, 1.15));
        put(w, h, d, 0, 'metal', color);
        put(w + 0.7, 0.5, d + 0.7, h, 'metal', color.clone().multiplyScalar(0.85));
        // Roller shutter across the gable end.
        scale.set(w * 0.34, h * 0.62, 0.25);
        groundMatrix(p.x, baseY, p.z, yaw, matrix, scale);
        matrix.multiply(new Matrix4().makeTranslation(0, 0, (d * 0.5 + 0.1) / 0.25));
        collector('metal').push(matrix, new Color(0.55, 0.56, 0.58));
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
  const signMesh = makeInstanced(unitBox(), plainMaterial(), signs, {
    castShadow: true,
    name: 'shop-signs',
  });
  if (signMesh) ctx.group.add(signMesh);
}

/**
 * Plan size of a building, drawn before the plot is tested so the ground can be
 * read at the footprint the building will actually have.
 */
function planBuilding(ctx: ChunkContext, kind: BuildingKind): { w: number; d: number; h: number } {
  switch (kind) {
    case 'house':
      return {
        w: ctx.rng.range(6, 9.5),
        d: ctx.rng.range(6.5, 11),
        h: ctx.rng.chance(0.45) ? ctx.rng.range(5.4, 6.8) : ctx.rng.range(2.9, 3.4),
      };
    case 'farmhouse':
      return { w: ctx.rng.range(9, 14), d: ctx.rng.range(7, 11), h: ctx.rng.range(3.0, 4.0) };
    case 'shophouse':
      return { w: ctx.rng.range(6, 10), d: ctx.rng.range(9, 14), h: ctx.rng.range(7, 11) };
    case 'block':
      return { w: ctx.rng.range(12, 22), d: ctx.rng.range(12, 22), h: ctx.rng.range(11, 28) };
    case 'tower':
      return { w: ctx.rng.range(14, 22), d: ctx.rng.range(14, 22), h: ctx.rng.range(30, 68) };
    default:
      return { w: ctx.rng.range(14, 28), d: ctx.rng.range(11, 20), h: ctx.rng.range(6, 9.5) };
  }
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

/**
 * A road running alongside the line, and the poles that follow it.
 *
 * The alignment of the road is a pure function of chainage (see `roadAt`), so
 * it is continuous from chunk to chunk; it is laid in runs that break wherever
 * the road has no business being - across a river with no bridge, over a
 * structure, through a station forecourt - rather than being pushed through.
 */
export function buildRoads(ctx: ChunkContext): void {
  const noise = ctx.field.noise;
  const builder = new MeshBuilder();
  const poles = new InstanceCollector();
  const wires = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const poleColor = new Color(0.62, 0.6, 0.56);
  const surface = new Color(0.62, 0.62, 0.63);

  let rows: Vector3[][] = [];
  let uvV: number[] = [];
  const flush = () => {
    if (rows.length > 2) builder.addSweep(rows, surface, uvV, [0, 0.05, 0.95, 1]);
    rows = [];
    uvV = [];
  };

  let previousPole: Vector3 | null = null;
  let nextPoleS = Math.ceil(ctx.sStart / 38) * 38;

  for (let i = 0; i < ctx.samples.length; i += 2) {
    const sample = ctx.samples[i];
    const road = roadAt(sample, noise);
    if (!road.present) {
      flush();
      previousPole = null;
      continue;
    }

    const rx = -Math.sin(sample.heading);
    const rz = Math.cos(sample.heading);
    const cx = sample.x + rx * road.centre;
    const cz = sample.z + rz * road.centre;
    // A road has to get over the water like anything else, and it has no
    // bridge - so it stops at the bank and starts again on the other side.
    if (waterProximity(ctx.field, sample, road.centre, cx, cz, road.half + 8) > 0.15) {
      flush();
      previousPole = null;
      continue;
    }

    const row: Vector3[] = [];
    for (const off of [-road.half, -road.half * 0.92, road.half * 0.92, road.half]) {
      const lat = road.centre + off;
      const x = sample.x + rx * lat;
      const z = sample.z + rz * lat;
      const y = ctx.field.ground(sample, lat, x, z) + 0.08;
      row.push(new Vector3(x, y, z));
    }
    rows.push(row);
    uvV.push(sample.s * 0.09);
    // The carriageway is somebody's ground: nothing else gets to stand on it.
    ctx.sites.claim(cx, cz, road.half + 1.5);

    if (sample.s >= nextPoleS) {
      // Step past whatever the last break in the road skipped, or the first
      // pole after a gap is followed by a row of them every few metres.
      while (nextPoleS <= sample.s) nextPoleS += 38;
      const poleLat = road.centre + road.side * (road.half + 1.6);
      const px = sample.x + rx * poleLat;
      const pz = sample.z + rz * poleLat;
      const py = ctx.field.ground(sample, poleLat, px, pz);
      scale.set(0.28, 9.5, 0.28);
      groundMatrix(px, py, pz, 0, matrix, scale);
      poles.push(matrix, poleColor);
      scale.set(1.8, 0.12, 0.12);
      groundMatrix(px, py + 8.6, pz, 0, matrix, scale);
      wires.add(unitBox(), matrix, poleColor);

      const top = new Vector3(px, py + 9.0, pz);
      if (previousPole) {
        const mid = previousPole.clone().add(top).multiplyScalar(0.5);
        mid.y -= 0.55;
        addWire(wires, previousPole, mid, top, new Color(0.12, 0.12, 0.12));
      }
      previousPole = top;
    }
  }
  flush();

  const mesh = builder.toMesh(asphaltMaterial(), true, 'road');
  if (mesh) {
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
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
    if (s0 + fieldLength >= ctx.sEnd) break;
    for (let side = -1; side <= 1; side += 2) {
      for (let lane = 0; lane < 9; lane++) {
        const lat = side * (24 + lane * fieldWidth);
        const centreS = s0 + fieldLength * 0.5;
        const p = place(ctx, centreS, lat);
        if (!p) continue;
        if (p.y < 1.0) continue;
        if (p.sample.structure !== 0) continue;
        if (onRoad(roadAt(p.sample, ctx.field.noise), lat, 2)) continue;
        if (waterProximity(ctx.field, p.sample, lat, p.x, p.z, 14) > 0.15) continue;
        const weight = blendedAttr(p.sample.weights, 'paddy');
        if (!ctx.rng.chance(clamp01(weight * 1.05))) continue;
        // Small enough that two fields on neighbouring lanes do not exclude
        // each other, large enough to keep a house out of the crop.
        const radius = 7.5;
        if (!ctx.sites.free(p.x, p.z, radius)) continue;
        const yaw = alignedYaw(p.sample.heading);

        // A paddy is a level pan held by a bund, and a bund is ankle high. Cut
        // one only where the ground is already close to level: on anything
        // steeper the pan has to stand proud at one end, and a rice field on a
        // plinth is a swimming pool.
        const { low, high } = footprint(ctx, p, fieldWidth * 0.5, fieldLength * 0.5, yaw);
        if (high - low > 0.5) continue;
        ctx.sites.claim(p.x, p.z, radius);

        const level = high - 0.06;
        const isFlooded = ctx.rng.chance(clamp01(0.55 - season * 0.5) + 0.2);
        const target = isFlooded ? flooded : planted;

        // The pan reaches down below the lowest corner, so no matter which way
        // the ground falls the water meets earth rather than air.
        const pan = level - (low - 0.5);
        scale.set(fieldWidth - 1.0, pan, fieldLength - 1.0);
        groundMatrix(p.x, low - 0.5, p.z, yaw, matrix, scale);
        target.add(unitBox(), matrix, white);

        // Bunds around the field: earth walked on by the farmer, not concrete.
        for (const [dl, ds, w, d] of [
          [-(fieldWidth - 0.6) * 0.5, 0, 0.55, fieldLength],
          [(fieldWidth - 0.6) * 0.5, 0, 0.55, fieldLength],
          [0, -(fieldLength - 0.6) * 0.5, fieldWidth, 0.55],
          [0, (fieldLength - 0.6) * 0.5, fieldWidth, 0.55],
        ] as [number, number, number, number][]) {
          scale.set(w, level - low + 0.26, d);
          groundMatrix(p.x, low - 0.02, p.z, yaw, matrix, scale);
          matrix.multiply(new Matrix4().makeTranslation(dl / w, 0, ds / d));
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

/**
 * River crossings and lineside canals, as water surfaces on carved ground.
 *
 * The river surface is generated from the same world-space axis the terrain
 * carved its valley from, so the water is on the bed by construction rather
 * than by both of them happening to agree. It runs the length of the modelled
 * river - a couple of kilometres either side of the line - narrowing towards
 * each end, so it goes somewhere instead of stopping in mid air.
 */
export function buildWaterways(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const depths: number[] = [];
  const point = { x: 0, z: 0 };

  for (const river of ctx.track.rivers) {
    if (river.s < ctx.sStart || river.s >= ctx.sEnd) continue;
    const axis = riverAxis(ctx.track, river);
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    const step = Math.max(24, axis.reach / 90);
    for (let t = -axis.reach; t <= axis.reach + 0.01; t += step) {
      const level = riverLevelAt(axis, t);
      const half = riverHalfAt(axis, t);
      const row: Vector3[] = [];
      // Column order runs from the right bank to the left so the surface faces
      // up. The shingle bars stand out of it; that is what braiding looks like.
      for (const u of [half, half * 0.6, half * 0.25, 0, -half * 0.25, -half * 0.6, -half]) {
        riverPoint(axis, t, u, ctx.field.noise, point);
        row.push(new Vector3(point.x, level, point.z));
        depths.push(Math.max(0.05, level - ctx.field.heightAt(point.x, point.z).y));
      }
      rows.push(row);
      uvV.push(t * 0.02);
    }
    if (rows.length > 1) {
      builder.addSweep(rows, new Color(1, 1, 1), uvV, [0, 0.2, 0.36, 0.5, 0.64, 0.8, 1]);
    }
  }

  // Lineside canal.
  const canalStrength = ctx.samples[0].riverStrength;
  if (canalStrength > 0.25) {
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    for (let i = 0; i < ctx.samples.length; i += 3) {
      const sample = ctx.samples[i];
      const centre = canalCentre(sample, ctx.field.noise);
      const width = canalWidth(sample, ctx.field.noise);
      const level = canalLevel(sample);
      const row: Vector3[] = [];
      for (const off of [-width * 0.42, 0, width * 0.42]) {
        const lat = centre + off;
        const rx = -Math.sin(sample.heading);
        const rz = Math.cos(sample.heading);
        const x = sample.x + rx * lat;
        const z = sample.z + rz * lat;
        row.push(new Vector3(x, level, z));
        depths.push(Math.max(0.1, level - ctx.field.ground(sample, lat, x, z)));
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

/**
 * Concrete cable troughing along the cess.
 *
 * It runs beside every electrified line there is, and from the cab it is the
 * thing the eye follows into the distance, so it does more for the look of the
 * lineside than anything else of its size.
 */
function buildCableRoute(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const lat = -6.35;
  // Half section of a trough with its lid: (lateral offset, height).
  const section: [number, number][] = [
    [-0.3, 0], [-0.3, 0.34], [-0.34, 0.34], [-0.34, 0.42],
    [0.34, 0.42], [0.34, 0.34], [0.3, 0.34], [0.3, 0],
  ];
  const body = new Color(0.62, 0.61, 0.58);
  const lid = new Color(0.7, 0.69, 0.66);
  const colors = section.map(([, h]) => (h > 0.36 ? lid : body));
  const uvU = section.map((_, i) => i / section.length);

  let rows: Vector3[][] = [];
  let uvV: number[] = [];
  const flush = () => {
    if (rows.length > 1) builder.addSweep(rows, colors, uvV, uvU, false);
    rows = [];
    uvV = [];
  };

  for (let s = ctx.sStart; s <= ctx.sEnd + 0.01; s += 2.5) {
    const p = place(ctx, s, lat);
    if (!p || p.sample.structure !== 0 || p.sample.stationZone > 0.6) {
      flush();
      continue;
    }
    const base = p.y - p.sample.y - 0.06;
    const row: Vector3[] = [];
    for (const [dl, h] of section) {
      row.push(trackPointAt(p.sample, lat + dl, base + h));
    }
    rows.push(row);
    uvV.push(s * 0.5);
  }
  flush();

  const mesh = builder.toMesh(concreteMaterial(), true, 'cable-route');
  if (mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
}

function trackPointAt(sample: TrackSample, lateral: number, height: number): Vector3 {
  const rx = -Math.sin(sample.heading);
  const rz = Math.cos(sample.heading);
  return new Vector3(sample.x + rx * lateral, sample.y + height, sample.z + rz * lateral);
}

/** Boundary fences, relay cabinets, rocks and other small lineside clutter. */
export function buildLinesideDetail(ctx: ChunkContext): void {
  const builder = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();
  const grey = new Color(0.66, 0.66, 0.64);
  const green = new Color(0.32, 0.4, 0.34);

  buildCableRoute(ctx);

  const first = ctx.samples[0];
  const built = blendedAttr(first.weights, 'buildingDensity');

  // Boundary fence where the line runs through built-up land. It stands on the
  // ground, not on the plane of the rails, so it is placed in world space and
  // squared to the line rather than rolled with the cant.
  if (built > 0.4) {
    for (const side of [-1, 1]) {
      const lat = side * 9.4;
      for (let s = ctx.sStart; s < ctx.sEnd; s += 3) {
        const p = place(ctx, s, lat);
        if (!p || p.sample.structure !== 0) continue;
        const yaw = alignedYaw(p.sample.heading);
        scale.set(0.07, 1.3, 0.07);
        groundMatrix(p.x, p.y, p.z, yaw, matrix, scale);
        builder.add(unitBox(), matrix, grey);
        scale.set(0.04, 0.04, 3.05);
        groundMatrix(p.x, p.y + 1.15, p.z, yaw, matrix, scale);
        builder.add(unitBox(), matrix, grey);
      }
    }
  }

  // Relay cabinets every few hundred metres, on a plinth.
  for (let s = Math.ceil(ctx.sStart / 180) * 180; s < ctx.sEnd; s += 180) {
    const p = place(ctx, s, -8.4);
    if (!p || p.sample.structure !== 0) continue;
    const yaw = alignedYaw(p.sample.heading);
    scale.set(1.15, 0.16, 0.85);
    groundMatrix(p.x, p.y - 0.05, p.z, yaw, matrix, scale);
    builder.add(unitBox(), matrix, grey);
    scale.set(0.9, 1.3, 0.6);
    groundMatrix(p.x, p.y + 0.11, p.z, yaw, matrix, scale);
    builder.add(unitBox(), matrix, green);
    scale.set(1.0, 0.08, 0.7);
    groundMatrix(p.x, p.y + 1.41, p.z, yaw, matrix, scale);
    builder.add(unitBox(), matrix, green);
  }

  // Distance posts: a marker every hundred metres, taller at each kilometre.
  const post = new Color(0.88, 0.87, 0.83);
  for (let s = Math.ceil(ctx.sStart / 100) * 100; s < ctx.sEnd; s += 100) {
    const p = place(ctx, s, 7.4);
    if (!p || p.sample.structure !== 0) continue;
    const yaw = alignedYaw(p.sample.heading);
    const whole = Math.abs(s % 1000) < 1;
    scale.set(0.16, whole ? 1.35 : 0.8, 0.16);
    groundMatrix(p.x, p.y, p.z, yaw, matrix, scale);
    builder.add(unitBox(), matrix, post);
    if (whole) {
      scale.set(0.44, 0.34, 0.07);
      groundMatrix(p.x, p.y + 1.05, p.z, yaw, matrix, scale);
      builder.add(unitBox(), matrix, post);
    }
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
    if (p.sample.structure !== 0 && Math.abs(lateral) < 26) continue;
    if (onRoad(roadAt(p.sample, ctx.field.noise), lateral, 1)) continue;
    if (!ctx.sites.free(p.x, p.z, 2)) continue;
    const rocky =
      p.sample.weights[BIOME_INDEX.mountain] * 1.2 + p.sample.weights[BIOME_INDEX.coast] * 0.9;
    if (!ctx.rng.chance(clamp01(rocky * 0.5))) continue;
    const size = ctx.rng.range(0.6, 3.4);
    scale.set(size * ctx.rng.range(0.8, 1.6), size * ctx.rng.range(0.5, 1.1), size * ctx.rng.range(0.8, 1.6));
    groundMatrix(p.x, p.y - size * 0.2, p.z, ctx.rng.range(0, 6.28), matrix, scale);
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
