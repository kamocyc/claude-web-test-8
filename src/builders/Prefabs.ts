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
import { hashFloat } from '../core/Random';
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

/**
 * Surface of revolution about the Y axis from a half section given as
 * (radius, height) pairs, capped top and bottom.
 *
 * Wheels, insulators, lamp hoods, air springs, buffer heads and vents are all
 * turned parts in the real world, and a stack of boxes never reads as one. The
 * section is walked once, so a wheel with a tread taper and a flange costs the
 * same as a cylinder to write.
 */
export function revolved(profile: [number, number][], segments = 12): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let j = 0; j < profile.length; j++) {
      const [r, y] = profile[j];
      positions.push(ca * r, y, sa * r);
      // Section normal, turned into the meridian plane.
      const prev = profile[Math.max(0, j - 1)];
      const next = profile[Math.min(profile.length - 1, j + 1)];
      const dr = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dr, dy) || 1;
      const nr = dy / len;
      const ny = -dr / len;
      normals.push(ca * nr, ny, sa * nr);
      uvs.push(i / segments, j / (profile.length - 1));
    }
  }
  const stride = profile.length;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < profile.length - 1; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Caps, as fans about the axis at each end.
  const capAt = (j: number, up: boolean) => {
    const centre = positions.length / 3;
    positions.push(0, profile[j][1], 0);
    normals.push(0, up ? 1 : -1, 0);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < segments; i++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      if (up) indices.push(centre, a, b);
      else indices.push(centre, b, a);
    }
  };
  if (profile[0][0] > 1e-5) capAt(0, false);
  if (profile[profile.length - 1][0] > 1e-5) capAt(profile.length - 1, true);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

const wheelCache = new Map<number, BufferGeometry>();
/**
 * A monobloc railway wheel of unit diameter, centred on its axle, with the
 * axle running along X.
 *
 * `inboard` is the direction the flange faces: -1 for a wheel on the +X rail,
 * +1 for one on the -X rail. The flange is what keeps a train on the road and
 * the one detail that makes a bogie read as a bogie rather than as a trolley,
 * so it is turned in rather than approximated by a disc - and it has to be on
 * the correct side of each wheel or the wheelset looks inside out.
 */
export function railWheel(inboard: 1 | -1): BufferGeometry {
  let geo = wheelCache.get(inboard);
  if (geo) return geo;
  // (radius, offset along the axle), as fractions of the wheel diameter, with
  // the flange towards -axial.
  const section: [number, number][] = [
    [0.11, -0.075],
    [0.30, -0.078],
    [0.455, -0.070], // web
    [0.520, -0.062], // flange root
    [0.562, -0.040], // flange tip
    [0.512, -0.022],
    [0.500, 0.010], // tread, coned 1:20 as a real one is
    [0.492, 0.070], // outer rim
    [0.30, 0.072],
    [0.11, 0.075],
  ];
  const oriented: [number, number][] =
    inboard < 0 ? section.map(([r, a]) => [r, -a] as [number, number]).reverse() : section;
  geo = revolved(oriented, 16);
  // Turned so the axle runs along X.
  geo.rotateZ(Math.PI / 2);
  wheelCache.set(inboard, geo);
  return geo;
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

const coniferCache = new Map<number, BufferGeometry>();
/**
 * Conifer crown: tiers of foliage tapering to a point, each one turned and
 * nudged off centre so the silhouette is not a stack of perfect cones. Three
 * variants are enough to stop a hillside looking cloned.
 */
export function coniferCrown(variant: number): BufferGeometry {
  let geo = coniferCache.get(variant);
  if (geo) return geo;
  const parts: BufferGeometry[] = [];
  const tiers = 5 + (variant % 3);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = Math.pow(1 - t, 0.78) * (0.9 + hashFloat(variant, i, 1) * 0.22);
    const h = 0.3 - t * 0.08 + hashFloat(variant, i, 2) * 0.06;
    const cone = unitCone(7).clone();
    cone.scale(r, h + 0.14, r);
    cone.rotateY(hashFloat(variant, i, 3) * 6.28);
    cone.translate(
      (hashFloat(variant, i, 4) - 0.5) * 0.07,
      t * 0.8 - (i === 0 ? 0.04 : 0),
      (hashFloat(variant, i, 5) - 0.5) * 0.07,
    );
    parts.push(cone);
  }
  geo = mergeGeometries(parts);
  coniferCache.set(variant, geo);
  return geo;
}

const canopyCache = new Map<number, BufferGeometry>();
/**
 * Broadleaf canopy: crossed leaf cards plus a couple of tilted ones over the
 * top, which is what stops a tree reading as a flat cut-out when you pass it.
 */
export function broadleafCanopy(variant: number): BufferGeometry {
  let geo = canopyCache.get(variant);
  if (geo) return geo;
  const parts: BufferGeometry[] = [];
  const upright = 4;
  for (let i = 0; i < upright; i++) {
    const plane = new PlaneGeometry(1, 1);
    plane.translate(0, 0.5, 0);
    const s = 0.82 + hashFloat(variant, i, 6) * 0.3;
    plane.scale(s, s, s);
    plane.rotateY((i / upright) * Math.PI + hashFloat(variant, i, 7) * 0.3);
    plane.translate((hashFloat(variant, i, 8) - 0.5) * 0.16, (0.5 - s * 0.5) + hashFloat(variant, i, 9) * 0.1, 0);
    parts.push(plane);
  }
  for (let i = 0; i < 2; i++) {
    const plane = new PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2 + (hashFloat(variant, i, 10) - 0.5) * 0.6);
    plane.scale(0.86, 0.86, 0.86);
    plane.rotateY(hashFloat(variant, i, 11) * 6.28);
    plane.translate(0, 0.58 + i * 0.22, 0);
    parts.push(plane);
  }
  geo = mergeGeometries(parts);
  canopyCache.set(variant, geo);
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
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
      flatShading: true,
      envMapIntensity: 0.45,
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

/**
 * Facade material for blocks and towers; windows glow after dark.
 *
 * The sheet carries eight floors of eight windows, and the shader scales its
 * UVs by the instance's own size, so a four storey block and a twenty storey
 * tower both end up with floors the same height and windows the same width
 * instead of the texture being stretched to fit.
 */
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
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         #ifdef USE_INSTANCING
           // One sheet covers 8 floors of 3.25 m and 8 bays of 3.1 m.
           vec2 facadeScale = vec2(
             length(instanceMatrix[0].xyz) / 24.8,
             length(instanceMatrix[1].xyz) / 26.0);
           #ifdef USE_MAP
             vMapUv *= facadeScale;
           #endif
           #ifdef USE_EMISSIVEMAP
             vEmissiveMapUv *= facadeScale;
           #endif
         #endif`,
      );
    };
    m.customProgramCacheKey = () => `facadeScaled${variant}`;
    return m;
  });
}

export function allFacadeMaterials(): MeshStandardMaterial[] {
  return [0, 1, 2, 3, 4].map((v) => facadeMaterial(v));
}

/**
 * Structural steel: masts, gantries, columns, fences, handrails.
 *
 * Almost none of the steel beside a railway is bare - it is galvanised or
 * painted, which is a fairly rough, only slightly metallic surface. Rendered
 * as a polished metal with nothing but sky to reflect it turns black, which is
 * what used to make every signal post and canopy column read as a silhouette.
 */
export function metalMaterial(): MeshStandardMaterial {
  return cached('metal', () =>
    new MeshStandardMaterial({
      map: textures.steel(),
      roughness: 0.6,
      metalness: 0.35,
      vertexColors: true,
      envMapIntensity: 0.8,
    }),
  );
}

/** Corrugated sheet: canopy roofs, warehouse cladding, lock-ups. */
export function corrugatedMaterial(): MeshStandardMaterial {
  return cached('corrugated', () =>
    new MeshStandardMaterial({
      map: textures.corrugated(),
      // Painted or coated sheet, not a mirror: at 0.45 metalness a canopy roof
      // reflects the whole sky and reads as a dark blue slab from underneath.
      roughness: 0.72,
      metalness: 0.18,
      vertexColors: true,
      envMapIntensity: 0.8,
    }),
  );
}

/** Diagonal yellow-and-black warning stripes: barriers, poles, buffer stops. */
export function hazardMaterial(): MeshStandardMaterial {
  return cached('hazard', () =>
    new MeshStandardMaterial({
      map: textures.hazardStripe(),
      roughness: 0.6,
      metalness: 0.05,
      vertexColors: true,
    }),
  );
}

/** Platform deck paving. */
export function platformMaterial(): MeshStandardMaterial {
  return cached('platformDeck', () =>
    new MeshStandardMaterial({
      map: textures.platform(),
      roughness: 0.88,
      metalness: 0,
      vertexColors: true,
    }),
  );
}

/** The dotted warning strip along a platform edge. */
export function tactileMaterial(): MeshStandardMaterial {
  return cached('tactile', () =>
    new MeshStandardMaterial({
      map: textures.tactile(),
      roughness: 0.78,
      metalness: 0,
      vertexColors: true,
    }),
  );
}

/** Road deck through a level crossing. */
export function crossingDeckMaterial(): MeshStandardMaterial {
  return cached('crossingDeck', () =>
    new MeshStandardMaterial({
      map: textures.crossingDeck(),
      roughness: 0.8,
      metalness: 0.05,
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
