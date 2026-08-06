import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Material,
  Vector3,
} from 'three';
import { blendedGrassColor } from './Biome';
import { TerrainField } from './TerrainField';
import { clamp01 } from '../core/MathUtils';
import type { ProjectionResult } from './TerrainField';

/**
 * Level-of-detail terrain tiles.
 *
 * Concentric rings of square tiles follow the camera: a fine 4 m grid close in,
 * coarsening by powers of two out to the fog limit. Every tile samples the same
 * `TerrainField`, so tiles of different resolutions meet without a visible
 * step; a downward skirt around each tile hides the remaining LOD cracks.
 */

interface TileLevel {
  size: number;
  segments: number;
  /** Half-extent in tiles: a (2r+1) x (2r+1) block around the camera. */
  radius: number;
}

// Ring sizes are a budget as much as a quality setting: a tile of the finest
// level costs as many height samples as one of the coarsest and covers a
// two-hundred-and-fiftieth of the ground, so the fine rings are kept tight and
// the coarse ones carry the distance.
const LEVELS: TileLevel[] = [
  // The finest ring is almost entirely hidden under the track-space corridor
  // mesh, so its resolution buys very little; the material carries the close
  // detail now, not the mesh.
  { size: 128, segments: 24, radius: 2 },
  { size: 256, segments: 24, radius: 3 },
  { size: 512, segments: 24, radius: 2 },
  { size: 1024, segments: 20, radius: 2 },
  // Coarse enough and a distant ridge turns into a row of facets against the
  // sky, which is the first thing that gives a generated landscape away.
  { size: 2048, segments: 16, radius: 2 },
];

/**
 * How far each ring is sunk below the one inside it, metres per level.
 *
 * Rings lap over each other by a cell, and over that cell the coarse surface is
 * as likely to be above the fine one as below - and where it is above, a single
 * hundred-and-twenty-metre facet lies across the hillside in place of the
 * detailed ground, shaded by its own coarse normal. Sinking each level a little
 * settles it: the finer surface always wins the lap, and the step this leaves
 * where the ring ends is inside what the skirt already covers.
 */
const LEVEL_SINK = 0.35;

/**
 * The rectangle a tile must leave out because a finer ring already covers it.
 *
 * Without this every ring is a solid block, so each level overlaps the one
 * inside it by up to half a tile. Two meshes of different resolution sampling
 * the same ground do not agree between their vertices, and the coarse one
 * comes through the fine one as flat facets and z-fighting - which is most of
 * what makes a generated middle distance look wrong, and on a steep hillside,
 * where the two disagree by tens of metres, it is a scatter of dark slabs
 * lying across the slope. Each ring is therefore punched hollow at exactly the
 * block inside it. A cell can only be dropped whole, so the ring still laps a
 * cell or so over the block - which is what leaves no gap - and `LEVEL_SINK`
 * makes sure the finer surface wins wherever they do lap.
 */
interface Hole {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Tile {
  key: string;
  level: number;
  ix: number;
  iz: number;
  mesh: Mesh;
  /** Distance from the camera when last evaluated, for build prioritisation. */
  priority: number;
}

interface TileJob {
  key: string;
  level: number;
  ix: number;
  iz: number;
  priority: number;
  hole: Hole | null;
}

export class TerrainTiles {
  readonly group = new Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly pending: TileJob[] = [];
  private readonly projection: ProjectionResult = { s: 0, lateral: 0, hint: -1, beyond: 0 };

  /** Number of levels actually used, reduced on lower quality settings. */
  levelCount = LEVELS.length;

  constructor(
    private readonly field: TerrainField,
    private readonly material: Material,
  ) {
    this.group.name = 'terrain-tiles';
    this.group.matrixAutoUpdate = false;
  }

  setViewDistance(distance: number): void {
    let count = 1;
    for (let i = 0; i < LEVELS.length; i++) {
      const reach = LEVELS[i].size * (LEVELS[i].radius + 0.5);
      count = i + 1;
      if (reach > distance) break;
    }
    this.levelCount = count;
  }

  /** Recomputes which tiles should exist and queues any that are missing. */
  refresh(cameraX: number, cameraZ: number): void {
    const wanted = new Set<string>();
    let innerMinX = Infinity;
    let innerMaxX = -Infinity;
    let innerMinZ = Infinity;
    let innerMaxZ = -Infinity;

    for (let level = 0; level < this.levelCount; level++) {
      const { size, radius } = LEVELS[level];
      const cx = Math.floor(cameraX / size);
      const cz = Math.floor(cameraZ / size);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      // What this ring must leave out: exactly the block inside it. Cells are
      // dropped whole, so the ones that straddle the edge stay and the ring
      // still laps over the block by up to one cell - no more than it has to.
      const hole: Hole | null =
        level > 0 && Number.isFinite(innerMinX)
          ? { minX: innerMinX, maxX: innerMaxX, minZ: innerMinZ, maxZ: innerMaxZ }
          : null;

      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ix = cx + dx;
          const iz = cz + dz;
          const x0 = ix * size;
          const z0 = iz * size;
          const x1 = x0 + size;
          const z1 = z0 + size;
          minX = Math.min(minX, x0);
          maxX = Math.max(maxX, x1);
          minZ = Math.min(minZ, z0);
          maxZ = Math.max(maxZ, z1);

          // Skip tiles already covered in full by the finer level inside.
          if (level > 0 && x0 >= innerMinX && x1 <= innerMaxX && z0 >= innerMinZ && z1 <= innerMaxZ) {
            continue;
          }

          // A tile clear of the hole is the same mesh wherever the camera is,
          // so it keeps a stable key and survives the camera moving; only the
          // few that straddle the boundary are keyed to it and rebuilt.
          const touches =
            hole !== null && x1 > hole.minX && x0 < hole.maxX && z1 > hole.minZ && z0 < hole.maxZ;
          const tileHole = touches ? hole : null;
          const key = tileHole
            ? `${level}:${ix}:${iz}:${tileHole.minX},${tileHole.maxX},${tileHole.minZ},${tileHole.maxZ}`
            : `${level}:${ix}:${iz}`;
          wanted.add(key);
          if (!this.tiles.has(key) && !this.pending.some((p) => p.key === key)) {
            const centreX = x0 + size * 0.5;
            const centreZ = z0 + size * 0.5;
            const priority = Math.hypot(centreX - cameraX, centreZ - cameraZ);
            this.pending.push({ key, level, ix, iz, priority, hole: tileHole });
          }
        }
      }
      innerMinX = minX;
      innerMaxX = maxX;
      innerMinZ = minZ;
      innerMaxZ = maxZ;
    }

    // Retire tiles that dropped out of range.
    for (const [key, tile] of this.tiles) {
      if (!wanted.has(key)) {
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        this.tiles.delete(key);
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (!wanted.has(this.pending[i].key)) this.pending.splice(i, 1);
    }
    // Build nearest first, but with a large head start for the coarse levels:
    // one 2 km tile covers as much ground as sixteen thousand of the finest
    // ones for a twentieth of the samples, and a hole at the horizon is not a
    // low-detail patch, it is a window through the world to the sky.
    const key = (t: { priority: number; level: number }) => t.priority - t.level * 900;
    this.pending.sort((a, b) => key(b) - key(a)); // last-in/first-out
  }

  /** Builds queued tiles until the time budget for this frame is used up. */
  processQueue(budgetMs: number): number {
    // A deep backlog means the world is being filled from nothing - the start
    // of a run, or after the view jumped somewhere else entirely. A few long
    // frames while that is closed are worth far less than holes in the ground,
    // so the budget is raised until the queue is back to a trickle.
    const deadline = performance.now() + (this.pending.length > 40 ? budgetMs * 2.5 : budgetMs);
    let built = 0;
    while (this.pending.length > 0 && performance.now() < deadline) {
      const job = this.pending.pop()!;
      if (this.tiles.has(job.key)) continue;
      const mesh = this.buildTile(job.level, job.ix, job.iz, job.hole);
      this.group.add(mesh);
      this.tiles.set(job.key, { ...job, mesh });
      built++;
    }
    return built;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  private buildTile(level: number, ix: number, iz: number, hole: Hole | null): Mesh {
    const { size, segments } = LEVELS[level];
    const step = size / segments;
    const originX = ix * size;
    const originZ = iz * size;

    /** Is this grid cell entirely inside the ground a finer ring already draws? */
    const cellHidden = (i: number, j: number): boolean => {
      if (!hole) return false;
      const x0 = originX + i * step;
      const z0 = originZ + j * step;
      return (
        x0 >= hole.minX && x0 + step <= hole.maxX && z0 >= hole.minZ && z0 + step <= hole.maxZ
      );
    };
    /** Deep enough inside the hole that no emitted triangle or normal reads it. */
    const pointHidden = (x: number, z: number): boolean =>
      hole !== null &&
      x > hole.minX + step * 2 &&
      x < hole.maxX - step * 2 &&
      z > hole.minZ + step * 2 &&
      z < hole.maxZ - step * 2;

    // Sample one extra ring of heights so normals at the tile border are
    // computed from real neighbours rather than from a clamped edge.
    const n = segments + 3;
    const heights = new Float32Array(n * n);
    const shore = new Float32Array(n * n);
    const colors = new Float32Array(n * n * 3);
    this.projection.hint = -1;
    const tint = this.field.noise.patches;
    // Projecting onto the centre line is the expensive part of building a
    // tile, and the search only has to reach as far as one cell of this tile
    // can move along the line. A coarse tile needs a wide window; the fine
    // ones nearest the camera - which are most of the samples - need very
    // little, so this is worth several milliseconds a tile.
    const window = Math.max(8, Math.min(48, Math.round(step * 0.5) + 6));
    let tintHint = -2;
    let tintR = 1;
    let tintG = 1;
    let tintB = 1;
    let lastHeight = 0;

    for (let j = 0; j < n; j++) {
      const z = originZ + (j - 1) * step;
      for (let i = 0; i < n; i++) {
        const x = originX + (i - 1) * step;
        const idx = j * n + i;
        if (pointHidden(x, z)) {
          // Never drawn and never read; carried at the last real height only so
          // the bounding sphere stays honest.
          heights[idx] = lastHeight;
          colors[idx * 3] = 1;
          colors[idx * 3 + 1] = 1;
          colors[idx * 3 + 2] = 1;
          continue;
        }
        const proj = this.field.project(x, z, this.projection.hint, this.projection, window);
        const sample = this.field.sampleFor(proj);
        const y = this.field.ground(sample, proj.lateral, x, z, true) - level * LEVEL_SINK;
        lastHeight = y;
        heights[idx] = y;
        shore[idx] = this.field.shoreFactor(sample, proj.lateral, y);
        // The tint only changes with the biome blend, which moves along the
        // line, not across it - so it is recomputed when the projection lands
        // on a different stored sample and reused otherwise.
        if (proj.hint !== tintHint) {
          tintHint = proj.hint;
          const col = blendedGrassColor(sample.weights);
          tintR = col.r;
          tintG = col.g;
          tintB = col.b;
        }
        // Large-scale colour variation so fields do not read as a flat wash.
        // The material carries its own drift as well; this one is coarser and
        // keeps neighbouring tiles from ever matching exactly.
        const wash = 0.88 + tint.fbm(x * 0.0016, z * 0.0016, 2) * 0.28;
        colors[idx * 3] = tintR * wash;
        colors[idx * 3 + 1] = tintG * wash;
        colors[idx * 3 + 2] = tintB * wash;
      }
    }

    const gridVerts = (segments + 1) * (segments + 1);
    const skirtVerts = (segments + 1) * 4;
    const total = gridVerts + skirtVerts;

    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const vcolors = new Float32Array(total * 3);
    const slopes = new Float32Array(total);
    const shores = new Float32Array(total);
    const cavities = new Float32Array(total);

    const normal = new Vector3();
    const at = (i: number, j: number) => heights[(j + 1) * n + (i + 1)];

    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        const vi = j * (segments + 1) + i;
        const x = i * step;
        const z = j * step;
        const y = at(i, j);
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;

        const dx = at(i + 1, j) - at(i - 1, j);
        const dz = at(i, j + 1) - at(i, j - 1);
        normal.set(-dx, 2 * step, -dz).normalize();
        normals[vi * 3] = normal.x;
        normals[vi * 3 + 1] = normal.y;
        normals[vi * 3 + 2] = normal.z;

        uvs[vi * 2] = (originX + x) * 0.06;
        uvs[vi * 2 + 1] = (originZ + z) * 0.06;

        const idx = (j + 1) * n + (i + 1);
        vcolors[vi * 3] = colors[idx * 3];
        vcolors[vi * 3 + 1] = colors[idx * 3 + 1];
        vcolors[vi * 3 + 2] = colors[idx * 3 + 2];
        slopes[vi] = clamp01(1 - normal.y);
        shores[vi] = shore[idx];

        // Curvature, as the discrete Laplacian of the height field. Positive
        // in a hollow, negative on a crest. The material darkens the hollows
        // and gathers scree and loose stone in them, which is most of what
        // reads as ambient occlusion on open ground - for the cost of four
        // samples we already had.
        const lap = (at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1)) * 0.25 - y;
        cavities[vi] = Math.max(-1, Math.min(1, lap / (step * 0.22)));
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        if (cellHidden(i, j)) continue;
        const a = j * (segments + 1) + i;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // Skirt: duplicate the border ring, dropped far enough to cover the height
    // a neighbour of a different resolution can miss - and no further.
    //
    // A fixed depth scaled to the cell is that depth everywhere, so on a level
    // where a cell is a hundred metres across it is a sixty-metre curtain, and
    // wherever the ground falls away it hangs clear of the hillside as a dark
    // flap. What it actually has to cover is how much the ground moves over
    // one cell *here*, which on the flat is nothing and on a mountainside is
    // metres - so that is what it is measured from.
    let sv = gridVerts;
    const addSkirt = (i: number, j: number): number => {
      const src = j * (segments + 1) + i;
      const relief = Math.max(
        Math.abs(at(i + 1, j) - at(i - 1, j)),
        Math.abs(at(i, j + 1) - at(i, j - 1)),
      );
      const drop = Math.min(16, 1.2 + LEVEL_SINK * level + relief * 1.3);
      const v = sv++;
      positions[v * 3] = positions[src * 3];
      positions[v * 3 + 1] = positions[src * 3 + 1] - drop;
      positions[v * 3 + 2] = positions[src * 3 + 2];
      normals[v * 3] = normals[src * 3];
      normals[v * 3 + 1] = normals[src * 3 + 1];
      normals[v * 3 + 2] = normals[src * 3 + 2];
      uvs[v * 2] = uvs[src * 2];
      uvs[v * 2 + 1] = uvs[src * 2 + 1];
      vcolors[v * 3] = vcolors[src * 3];
      vcolors[v * 3 + 1] = vcolors[src * 3 + 1];
      vcolors[v * 3 + 2] = vcolors[src * 3 + 2];
      slopes[v] = slopes[src];
      shores[v] = shores[src];
      cavities[v] = cavities[src];
      return v;
    };

    // A skirt only belongs where the tile has an edge to hide. Hung from a
    // border that a finer ring already covers it is a dark flap standing in the
    // middle of the ground.
    for (let i = 0; i < segments; i++) {
      if (cellHidden(i, 0)) continue;
      const a = i * 1 + 0 * (segments + 1);
      const b = a + 1;
      const sa = addSkirt(i, 0);
      const sb = addSkirt(i + 1, 0);
      indices.push(a, b, sa, b, sb, sa);
    }
    for (let i = 0; i < segments; i++) {
      if (cellHidden(i, segments - 1)) continue;
      const a = segments * (segments + 1) + i;
      const b = a + 1;
      const sa = addSkirt(i, segments);
      const sb = addSkirt(i + 1, segments);
      indices.push(a, sa, b, b, sa, sb);
    }
    for (let j = 0; j < segments; j++) {
      if (cellHidden(0, j)) continue;
      const a = j * (segments + 1);
      const b = a + (segments + 1);
      const sa = addSkirt(0, j);
      const sb = addSkirt(0, j + 1);
      indices.push(a, sa, b, b, sa, sb);
    }
    for (let j = 0; j < segments; j++) {
      if (cellHidden(segments - 1, j)) continue;
      const a = j * (segments + 1) + segments;
      const b = a + (segments + 1);
      const sa = addSkirt(segments, j);
      const sb = addSkirt(segments, j + 1);
      indices.push(a, b, sa, b, sb, sa);
    }

    // Skirt segments the hole suppressed leave unused slots at the end of the
    // buffers; trim them rather than shipping vertices at the origin.
    const used = sv;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions.subarray(0, used * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(normals.subarray(0, used * 3), 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs.subarray(0, used * 2), 2));
    geometry.setAttribute('color', new BufferAttribute(vcolors.subarray(0, used * 3), 3));
    geometry.setAttribute('aSlope', new BufferAttribute(slopes.subarray(0, used), 1));
    geometry.setAttribute('aShore', new BufferAttribute(shores.subarray(0, used), 1));
    geometry.setAttribute('aCavity', new BufferAttribute(cavities.subarray(0, used), 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, this.material);
    mesh.position.set(originX, 0, originZ);
    mesh.receiveShadow = level <= 1;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = -10 + level;
    return mesh;
  }

  dispose(): void {
    for (const tile of this.tiles.values()) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.pending.length = 0;
  }
}
