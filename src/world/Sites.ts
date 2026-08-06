import { blendedAttr } from './Biome';
import { canalCentre, canalWidth } from './TerrainField';
import { riverAxis, sampleRiver } from './River';
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
 *
 * Footprints are rectangles, not circles. A rice paddy is seventeen metres by
 * twenty-two and a warehouse is twenty-eight by eleven; a disc that contains
 * either of them is half again too big, and one that fits inside leaves the
 * corners free for something else to be built in. Paddies in particular are
 * laid edge to edge on a grid, so anything but the true rectangle either has
 * them refusing to sit next to each other or lets a farmhouse into the crop.
 */

/** Cell size of the occupancy hash, metres. */
const CELL = 32;

/**
 * A footprint: centre, half extents along its own axes, and those axes as the
 * cosine and sine of its yaw. The local axes match `groundMatrix` - local +X to
 * the right, local +Z back - so a builder passes the same yaw it draws with.
 */
interface Rect {
  x: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  /** Circumradius, for the broad phase. */
  r: number;
}

function rect(x: number, z: number, hx: number, hz: number, yaw: number): Rect {
  return { x, z, hx, hz, cos: Math.cos(yaw), sin: Math.sin(yaw), r: Math.hypot(hx, hz) };
}

/** Extent of a rectangle projected onto a unit axis. */
function extent(a: Rect, ux: number, uz: number): number {
  // Local +X is (cos, -sin), local +Z is (sin, cos).
  return (
    a.hx * Math.abs(ux * a.cos - uz * a.sin) + a.hz * Math.abs(ux * a.sin + uz * a.cos)
  );
}

/** Separating-axis test between two rectangles. */
function overlaps(a: Rect, b: Rect): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const reach = a.r + b.r;
  if (dx * dx + dz * dz > reach * reach) return false;
  const axes = [
    [a.cos, -a.sin],
    [a.sin, a.cos],
    [b.cos, -b.sin],
    [b.sin, b.cos],
  ];
  for (const [ux, uz] of axes) {
    if (Math.abs(dx * ux + dz * uz) > extent(a, ux, uz) + extent(b, ux, uz)) return false;
  }
  return true;
}

/** Ground already spoken for by something with a footprint. */
export class Occupancy {
  private readonly cells = new Map<number, Rect[]>();

  private static key(cx: number, cz: number): number {
    return cx * 73856093 + cz * 19349663;
  }

  private forCells(r: Rect, visit: (key: number) => void): void {
    const cx0 = Math.floor((r.x - r.r) / CELL);
    const cx1 = Math.floor((r.x + r.r) / CELL);
    const cz0 = Math.floor((r.z - r.r) / CELL);
    const cz1 = Math.floor((r.z + r.r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) visit(Occupancy.key(cx, cz));
    }
  }

  /** True when this footprint touches nothing already claimed. */
  free(x: number, z: number, hx: number, hz: number, yaw = 0): boolean {
    const probe = rect(x, z, hx, hz, yaw);
    let clear = true;
    this.forCells(probe, (key) => {
      if (!clear) return;
      const bucket = this.cells.get(key);
      if (!bucket) return;
      for (const other of bucket) {
        if (overlaps(probe, other)) {
          clear = false;
          return;
        }
      }
    });
    return clear;
  }

  /** Books a footprint. */
  claim(x: number, z: number, hx: number, hz: number, yaw = 0): void {
    const claim = rect(x, z, hx, hz, yaw);
    this.forCells(claim, (key) => {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(claim);
      else this.cells.set(key, [claim]);
    });
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

/**
 * Does something of this half width, centred at this lateral offset, foul the
 * road?
 *
 * `half` is the caller's own half width, not a clearance: testing the centre
 * point alone let a twenty-two metre building sit ten metres off the road
 * centre and cover the whole carriageway.
 */
export function onRoad(road: RoadAt, lateral: number, half: number, clearance = 1.5): boolean {
  return road.present && Math.abs(lateral - road.centre) < road.half + half + clearance;
}

// --- water -----------------------------------------------------------------

/**
 * Is this footprint in the water?
 *
 * Nothing is built in a river bed, on the flood side of a levee or in the
 * lineside drain. The test takes the caller's own size, because a house is not
 * a point: one centred a metre outside the bank still has half of it in the
 * river. It also ignores how much river there is left this far up- or
 * downstream - the water surface is drawn over the whole modelled reach, so a
 * house at the far end of one is in the water just as wet as a house at the
 * bridge.
 */
export function inWater(
  field: TerrainField,
  sample: TrackSample,
  lateral: number,
  x: number,
  z: number,
  half: number,
  ground = Infinity,
): boolean {
  for (const river of field.track.rivers) {
    const axis = riverAxis(field.track, river);
    const r = sampleRiver(axis, x, z, field.noise, half + 110);
    if (!r) continue;
    // The bed itself, plus the batter of the bank above it.
    if (r.dist < r.half + half + 14) return true;
    // And anything the river could reach: inside the levees, the flood plain
    // is not building land however dry it looks today.
    if (ground < r.level + 1.6 && r.dist < r.half + half + 90) return true;
  }
  if (sample.riverStrength > 0.05) {
    const dist = Math.abs(lateral - canalCentre(sample, field.noise));
    if (dist < canalWidth(sample, field.noise) * 0.5 + half + 5) return true;
  }
  return false;
}
