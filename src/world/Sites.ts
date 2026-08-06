import { blendedAttr } from './Biome';
import { canalCentre, canalWidth } from './TerrainField';
import { riverAxis, riverProximity, sampleRiver } from './River';
import { STRUCT_GROUND, type TrackSample } from './TrackPath';
import type { TerrainNoise } from './Biome';
import type { TerrainField } from './TerrainField';

/**
 * Who gets to stand where.
 *
 * Scenery used to be scattered independently by each builder, so a house, the
 * road it should front onto and the river it should be a safe distance from
 * were all placed without any of them knowing the others existed - which is
 * why buildings ended up in the carriageway and standing in the water. Land is
 * claimed here instead: the road is a function every builder can ask about,
 * water is a function every builder can ask about, and everything with a
 * footprint books its ground before it is built.
 */

/** Cell size of the occupancy hash, metres. */
const CELL = 32;

interface Claim {
  x: number;
  z: number;
  r: number;
}

/** Ground already spoken for by something with a footprint. */
export class Occupancy {
  private readonly cells = new Map<number, Claim[]>();

  private static key(cx: number, cz: number): number {
    // Both indices fit comfortably in the range a route ever reaches.
    return cx * 73856093 + cz * 19349663;
  }

  /** True when a disc of `r` about (x, z) touches nothing already claimed. */
  free(x: number, z: number, r: number): boolean {
    const cx0 = Math.floor((x - r) / CELL);
    const cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL);
    const cz1 = Math.floor((z + r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.cells.get(Occupancy.key(cx, cz));
        if (!bucket) continue;
        for (const c of bucket) {
          const dx = c.x - x;
          const dz = c.z - z;
          const reach = c.r + r;
          if (dx * dx + dz * dz < reach * reach) return false;
        }
      }
    }
    return true;
  }

  /** Books a disc of ground. */
  claim(x: number, z: number, r: number): void {
    const claim: Claim = { x, z, r };
    const cx0 = Math.floor((x - r) / CELL);
    const cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL);
    const cz1 = Math.floor((z + r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = Occupancy.key(cx, cz);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(claim);
        else this.cells.set(key, [claim]);
      }
    }
  }
}

// --- the lineside road -----------------------------------------------------

/** The road beside the line at a chainage, if there is one. */
export interface RoadAt {
  present: boolean;
  /** Lateral offset of the road centre from the track centre line. */
  centre: number;
  /** Half the carriageway width. */
  half: number;
  /** Which side of the line it runs on. */
  side: number;
}

const roadResult: RoadAt = { present: false, centre: 0, half: 0, side: 1 };

/**
 * Where the lineside road runs.
 *
 * A pure function of chainage, so the road is the same road in every chunk it
 * passes through: it used to be resampled from the chunk's own start, which
 * stepped it sideways every two hundred and fifty metres. Where the noise that
 * chooses its side passes through zero the road simply stops, rather than
 * jumping across the railway.
 */
export function roadAt(sample: TrackSample, noise: TerrainNoise, out = roadResult): RoadAt {
  const density = blendedAttr(sample.weights, 'roadDensity');
  const swing = noise.patches.sample(sample.s * 0.00035, 88.2);
  out.side = swing >= 0 ? 1 : -1;
  out.half = density > 1.2 ? 6 : 3.6;
  out.centre =
    out.side * (24 + Math.abs(noise.hills.sample(sample.s * 0.001, 4.4)) * 14 + out.half);
  out.present =
    density >= 0.42 &&
    Math.abs(swing) > 0.16 &&
    sample.structure === STRUCT_GROUND &&
    sample.stationZone < 0.7;
  return out;
}

/** How much of the road corridor a lateral offset falls in: 1 on it, 0 clear. */
export function onRoad(road: RoadAt, lateral: number, margin: number): boolean {
  return road.present && Math.abs(lateral - road.centre) < road.half + margin;
}

// --- water -----------------------------------------------------------------

/**
 * How wet a world position is: 1 in a river bed or a canal, 0 on dry land.
 *
 * Everything that is built asks this before it is placed, which is the whole
 * of the fix for houses standing in the water: the water is not something the
 * scatter can discover after the fact from a height, because a gravel bar is
 * dry and a field below the levee is not.
 */
export function waterProximity(
  field: TerrainField,
  sample: TrackSample,
  lateral: number,
  x: number,
  z: number,
  margin = 26,
): number {
  let wet = 0;
  for (const river of field.track.rivers) {
    const axis = riverAxis(field.track, river);
    const r = sampleRiver(axis, x, z, field.noise, margin + 10);
    if (!r) continue;
    wet = Math.max(wet, riverProximity(r, margin));
  }
  const canal = sample.riverStrength;
  if (canal > 0.05) {
    const dist = Math.abs(lateral - canalCentre(sample, field.noise));
    const half = canalWidth(sample, field.noise) * 0.5;
    if (dist < half + margin) wet = Math.max(wet, canal);
  }
  return wet;
}
