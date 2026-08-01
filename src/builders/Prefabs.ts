import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Material,
} from 'three';
import { textures } from '../materials/TextureFactory';
import { getFoliageMaterial, getGrassMaterial } from '../materials/Materials';
import type { InstanceCollector } from './MeshBuilder';

/** Cached primitive geometries, all with their origin on the ground plane. */

let boxCache: BufferGeometry | null = null;
export function unitBox(): BufferGeometry {
  if (!boxCache) {
    boxCache = new BoxGeometry(1, 1, 1);
    boxCache.translate(0, 0.5, 0);
  }
  return boxCache;
}

const cylinderCache = new Map<number, BufferGeometry>();
export function unitCylinder(segments = 8): BufferGeometry {
  let geo = cylinderCache.get(segments);
  if (!geo) {
    geo = new CylinderGeometry(0.5, 0.5, 1, segments, 1, false);
    geo.translate(0, 0.5, 0);
    cylinderCache.set(segments, geo);
  }
  return geo;
}

const taperCache = new Map<string, BufferGeometry>();
/** Tapered cylinder, used for tree trunks and masts. */
export function taperedCylinder(topScale: number, segments = 6): BufferGeometry {
  const key = `${topScale}_${segments}`;
  let geo = taperCache.get(key);
  if (!geo) {
    geo = new CylinderGeometry(0.5 * topScale, 0.5, 1, segments, 1, false);
    geo.translate(0, 0.5, 0);
    taperCache.set(key, geo);
  }
  return geo;
}

const coneCache = new Map<number, BufferGeometry>();
export function unitCone(segments = 7): BufferGeometry {
  let geo = coneCache.get(segments);
  if (!geo) {
    geo = new ConeGeometry(0.5, 1, segments, 1, false);
    geo.translate(0, 0.5, 0);
    coneCache.set(segments, geo);
  }
  return geo;
}

let sphereCache: BufferGeometry | null = null;
export function unitSphere(): BufferGeometry {
  if (!sphereCache) {
    sphereCache = new SphereGeometry(0.5, 10, 7);
    sphereCache.translate(0, 0.5, 0);
  }
  return sphereCache;
}

let planeCache: BufferGeometry | null = null;
export function unitPlane(): BufferGeometry {
  if (!planeCache) {
    planeCache = new PlaneGeometry(1, 1);
    planeCache.rotateX(-Math.PI / 2);
  }
  return planeCache;
}

const cardCache = new Map<number, BufferGeometry>();
/** `count` vertical quads crossing through the origin, for foliage and grass. */
export function crossCards(count = 3): BufferGeometry {
  let geo = cardCache.get(count);
  if (geo) return geo;
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const plane = new PlaneGeometry(1, 1);
    plane.translate(0, 0.5, 0);
    plane.rotateY((i / count) * Math.PI);
    parts.push(plane);
  }
  geo = mergeGeometries(parts);
  cardCache.set(count, geo);
  return geo;
}

/** Minimal geometry merge for the small set of attributes we use. */
export function mergeGeometries(list: BufferGeometry[]): BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.getAttribute('position').count;
    indexCount += g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    positions.set(p.array as Float32Array, vo * 3);
    if (n) normals.set(n.array as Float32Array, vo * 3);
    if (u) uvs.set(u.array as Float32Array, vo * 2);
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[io + i] = idx.getX(i) + vo;
      io += idx.count;
    } else {
      for (let i = 0; i < p.count; i++) indices[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

let gableCache: BufferGeometry | null = null;
/** Gable roof: unit footprint, ridge running along Z, apex at y = 1. */
export function gableRoof(): BufferGeometry {
  if (gableCache) return gableCache;
  const p: number[] = [];
  const n: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const push = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ) => {
    const base = p.length / 3;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    p.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) n.push(nx, ny, nz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // Two slopes.
  push(-0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5);
  push(0, 1, -0.5, 0, 1, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5);
  // Gable ends (as degenerate quads collapsing to triangles).
  push(-0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, -0.5, 0.5, 0, -0.5);
  push(0.5, 0, 0.5, 0, 1, 0.5, -0.5, 0, 0.5, -0.5, 0, 0.5);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(n), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  gableCache = geo;
  return geo;
}

let hipCache: BufferGeometry | null = null;
/** Hipped roof with a short ridge - the classic Japanese farmhouse silhouette. */
export function hipRoof(): BufferGeometry {
  if (hipCache) return hipCache;
  const p: number[] = [];
  const n: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    const base = p.length / 3;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) n.push(nx, ny, nz);
    uv.push(0, 0, 1, 0, 0.5, 1);
    idx.push(base, base + 1, base + 2);
  };
  const r = 0.22; // half ridge length along Z
  // Long slopes.
  tri(-0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, r);
  tri(-0.5, 0, -0.5, 0, 1, r, 0, 1, -r);
  tri(0.5, 0, 0.5, 0.5, 0, -0.5, 0, 1, -r);
  tri(0.5, 0, 0.5, 0, 1, -r, 0, 1, r);
  // Hips.
  tri(-0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, r);
  tri(0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, -r);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(n), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  hipCache = geo;
  return geo;
}

// --- prop materials --------------------------------------------------------

const materialCache = new Map<string, MeshStandardMaterial>();

function cached(key: string, make: () => MeshStandardMaterial): MeshStandardMaterial {
  let m = materialCache.get(key);
  if (!m) {
    m = make();
    materialCache.set(key, m);
  }
  return m;
}

export function trunkMaterial(): MeshStandardMaterial {
  return cached('trunk', () => {
    const m = new MeshStandardMaterial({
      map: textures.bark(),
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
    });
    return m;
  });
}

export function coniferMaterial(): MeshStandardMaterial {
  return cached('conifer', () => {
    const m = new MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
      flatShading: true,
    });
    return m;
  });
}

export function broadleafMaterial(): MeshStandardMaterial {
  return getFoliageMaterial();
}

export function grassMaterial(): MeshStandardMaterial {
  return getGrassMaterial();
}

export function sidingMaterial(): MeshStandardMaterial {
  return cached('siding', () => {
    const m = new MeshStandardMaterial({
      map: textures.siding(0xffffff),
      roughness: 0.82,
      metalness: 0,
      vertexColors: true,
    });
    return m;
  });
}

export function roofMaterial(): MeshStandardMaterial {
  return cached('roof', () => {
    const m = new MeshStandardMaterial({
      map: textures.roofTile(0xffffff),
      roughness: 0.72,
      metalness: 0.05,
      vertexColors: true,
    });
    return m;
  });
}

/** Facade material for blocks and towers; windows glow after dark. */
export function facadeMaterial(variant: number): MeshStandardMaterial {
  return cached(`facade${variant}`, () => {
    const m = new MeshStandardMaterial({
      map: textures.facade(variant, 0.45),
      emissiveMap: textures.facadeEmissive(variant, 0.45),
      emissive: new Color(0xffffff),
      emissiveIntensity: 0,
      roughness: 0.68,
      metalness: 0.08,
      vertexColors: true,
    });
    return m;
  });
}

export function allFacadeMaterials(): MeshStandardMaterial[] {
  return [0, 1, 2, 3, 4].map((v) => facadeMaterial(v));
}

export function metalMaterial(): MeshStandardMaterial {
  return cached('metal', () =>
    new MeshStandardMaterial({
      map: textures.steel(),
      roughness: 0.55,
      metalness: 0.7,
      vertexColors: true,
    }),
  );
}

export function concreteMaterial(): MeshStandardMaterial {
  return cached('concreteProp', () =>
    new MeshStandardMaterial({
      map: textures.concrete(),
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
    }),
  );
}

export function asphaltMaterial(): MeshStandardMaterial {
  return cached('asphaltProp', () =>
    new MeshStandardMaterial({
      map: textures.asphalt(),
      roughness: 0.88,
      metalness: 0,
      vertexColors: true,
    }),
  );
}

export function paddyMaterial(season: number): MeshStandardMaterial {
  return cached(`paddy${season}`, () =>
    new MeshStandardMaterial({
      map: textures.paddy(season),
      roughness: 0.85,
      metalness: 0,
      vertexColors: true,
      side: DoubleSide,
    }),
  );
}

export function plainMaterial(): MeshStandardMaterial {
  return cached('plain', () =>
    new MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, vertexColors: true }),
  );
}

/** Sets the night-time window glow on every facade material at once. */
export function setFacadeNight(intensity: number): void {
  for (const [key, mat] of materialCache) {
    if (key.startsWith('facade')) mat.emissiveIntensity = intensity;
  }
}

/**
 * Materials in this project use vertex colours so that one material can serve
 * many differently coloured props. A geometry without a `color` attribute would
 * therefore render black, so give every instanced prefab a white one.
 */
function ensureVertexColors(geometry: BufferGeometry): void {
  if (geometry.getAttribute('color')) return;
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  colors.fill(1);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

/** Builds an InstancedMesh from collected transforms, or null if empty. */
export function makeInstanced(
  geometry: BufferGeometry,
  material: Material,
  collector: InstanceCollector,
  options: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
): InstancedMesh | null {
  if (collector.count === 0) return null;
  ensureVertexColors(geometry);
  const mesh = new InstancedMesh(geometry, material, collector.count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const m = new Matrix4();
  for (let i = 0; i < collector.count; i++) {
    m.copy(collector.matrices[i]);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, collector.colors[i]);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? false;
  mesh.name = options.name ?? '';
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  return mesh;
}
