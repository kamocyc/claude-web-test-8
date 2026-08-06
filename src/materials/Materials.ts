import {
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector2,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { textures } from './TextureFactory';
import { createGroundMaterial } from '../world/terrain/GroundMaterial';

/**
 * Shared material library.
 *
 * Materials are created once and reused across every chunk so the renderer can
 * batch aggressively; per-object variation comes from instance colours and
 * geometry rather than from unique materials.
 */

/** Uniforms shared by all wind-affected materials. */
export const windUniforms: Record<string, IUniform> = {
  uTime: { value: 0 },
  uWind: { value: new Vector2(1, 0.3) },
  uWindStrength: { value: 1 },
};

const windPatchedShaders: WebGLProgramParametersWithUniforms[] = [];

export function updateWind(time: number, dirX: number, dirZ: number, strength: number): void {
  windUniforms.uTime.value = time;
  (windUniforms.uWind.value as Vector2).set(dirX, dirZ);
  windUniforms.uWindStrength.value = strength;
  for (const shader of windPatchedShaders) {
    shader.uniforms.uTime.value = time;
    (shader.uniforms.uWind.value as Vector2).set(dirX, dirZ);
    shader.uniforms.uWindStrength.value = strength;
  }
}

const windVertexHeader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uWindStrength;

  float windHash(vec2 p) {
    return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453);
  }
`;

/**
 * Sway that increases with height above the instance origin, with a
 * per-instance phase offset so a forest never moves in lockstep.
 */
const windVertexBody = /* glsl */ `
  #ifdef USE_INSTANCING
    vec3 instanceOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #else
    vec3 instanceOrigin = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
  #endif
  float phase = windHash(instanceOrigin.xz * 0.37) * 6.2831853;
  float heightFactor = clamp(transformed.y * WIND_HEIGHT_SCALE, 0.0, 3.0);
  float gust = sin(uTime * 1.35 + phase + instanceOrigin.x * 0.06) * 0.6
             + sin(uTime * 2.9 + phase * 1.7) * 0.25
             + sin(uTime * 0.47 + phase * 0.4) * 0.4;
  vec2 sway = uWind * gust * uWindStrength * heightFactor * WIND_AMPLITUDE;
  transformed.x += sway.x;
  transformed.z += sway.y;
`;

function patchWind(material: Material, amplitude: number, heightScale: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n#define WIND_AMPLITUDE ${amplitude.toFixed(4)}\n#define WIND_HEIGHT_SCALE ${heightScale.toFixed(4)}\n${windVertexHeader}`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${windVertexBody}`);
    windPatchedShaders.push(shader);
  };
  material.customProgramCacheKey = () => `wind${amplitude}_${heightScale}`;
}

/**
 * Terrain.
 *
 * The ground is involved enough to live on its own, next to the height field
 * that feeds it: see world/terrain/GroundMaterial.
 */
export function createTerrainMaterial(): MeshStandardMaterial {
  return createGroundMaterial();
}

let ballastMaterial: MeshStandardMaterial | null = null;
export function getBallastMaterial(): MeshStandardMaterial {
  if (!ballastMaterial) {
    ballastMaterial = new MeshStandardMaterial({
      map: textures.ballast(),
      normalMap: textures.ballastNormal(),
      normalScale: new Vector2(1.2, 1.2),
      roughness: 0.95,
      metalness: 0.02,
      color: 0x8d8880,
    });
  }
  return ballastMaterial;
}

let railMaterial: MeshStandardMaterial | null = null;
export function getRailMaterial(): MeshStandardMaterial {
  if (!railMaterial) {
    railMaterial = new MeshStandardMaterial({
      color: 0x5b5852,
      roughness: 0.42,
      metalness: 0.88,
    });
  }
  return railMaterial;
}

/** The polished top of the rail head, which catches the sun. */
let railHeadMaterial: MeshStandardMaterial | null = null;
export function getRailHeadMaterial(): MeshStandardMaterial {
  if (!railHeadMaterial) {
    railHeadMaterial = new MeshStandardMaterial({
      color: 0xc8c6c0,
      roughness: 0.16,
      metalness: 1.0,
    });
  }
  return railHeadMaterial;
}

let sleeperMaterial: MeshStandardMaterial | null = null;
export function getSleeperMaterial(): MeshStandardMaterial {
  if (!sleeperMaterial) {
    sleeperMaterial = new MeshStandardMaterial({
      map: textures.concrete(),
      color: 0x8f8a80,
      roughness: 0.92,
      metalness: 0,
    });
  }
  return sleeperMaterial;
}

const simpleCache = new Map<string, MeshStandardMaterial>();

/** Untextured standard material, cached by its parameters. */
export function getSimpleMaterial(
  color: number,
  roughness = 0.8,
  metalness = 0,
  extra?: { emissive?: number; emissiveIntensity?: number; transparent?: boolean; opacity?: number },
): MeshStandardMaterial {
  const key = `${color}_${roughness}_${metalness}_${extra?.emissive ?? ''}_${extra?.emissiveIntensity ?? ''}_${extra?.opacity ?? ''}`;
  const hit = simpleCache.get(key);
  if (hit) return hit;
  const mat = new MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive: extra?.emissive ?? 0x000000,
    emissiveIntensity: extra?.emissiveIntensity ?? 1,
    transparent: extra?.transparent ?? false,
    opacity: extra?.opacity ?? 1,
  });
  simpleCache.set(key, mat);
  return mat;
}

const texturedCache = new Map<string, MeshStandardMaterial>();

export function getTexturedMaterial(
  key: string,
  make: () => MeshStandardMaterial,
): MeshStandardMaterial {
  const hit = texturedCache.get(key);
  if (hit) return hit;
  const mat = make();
  texturedCache.set(key, mat);
  return mat;
}

let foliageMaterial: MeshStandardMaterial | null = null;
/** Leaf cards: alpha tested, double sided, with wind sway and translucency. */
export function getFoliageMaterial(): MeshStandardMaterial {
  if (!foliageMaterial) {
    foliageMaterial = new MeshStandardMaterial({
      map: textures.leafCluster(0xffffff),
      alphaTest: 0.42,
      transparent: false,
      side: DoubleSide,
      roughness: 0.88,
      metalness: 0,
      vertexColors: true,
      // Leaves are not mirrors: too much sky reflected off them and a wood
      // washes out to a pale grey-green.
      envMapIntensity: 0.45,
    });
    patchWind(foliageMaterial, 0.11, 0.32);
  }
  return foliageMaterial;
}

let grassMaterial: MeshStandardMaterial | null = null;
export function getGrassMaterial(): MeshStandardMaterial {
  if (!grassMaterial) {
    grassMaterial = new MeshStandardMaterial({
      map: textures.grassBlades(0xffffff),
      alphaTest: 0.36,
      side: DoubleSide,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.5,
    });
    patchWind(grassMaterial, 0.055, 1.35);
  }
  return grassMaterial;
}

let barkMaterial: MeshStandardMaterial | null = null;
export function getBarkMaterial(): MeshStandardMaterial {
  if (!barkMaterial) {
    barkMaterial = new MeshStandardMaterial({
      map: textures.bark(),
      roughness: 0.95,
      metalness: 0,
      vertexColors: true,
    });
    patchWind(barkMaterial, 0.02, 0.12);
  }
  return barkMaterial;
}

/** Glazing for trains, buildings and signal lenses. */
export function createGlassMaterial(tint = 0x2c3a42, opacity = 0.55): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: tint,
    roughness: 0.06,
    metalness: 0,
    transmission: 0,
    transparent: true,
    opacity,
    envMapIntensity: 1.4,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    side: FrontSide,
  });
}

/**
 * Bodyside material for rolling stock.
 *
 * Japanese commuter stock is a laser-welded stainless shell, not a painted one:
 * it is a fairly rough metal that carries the beading rolled along the car and
 * takes a coloured film rather than paint. Vertex colour supplies the livery
 * band, so one material serves the whole shell.
 */
let stainlessMaterial: MeshStandardMaterial | null = null;
export function getStainlessMaterial(): MeshStandardMaterial {
  if (!stainlessMaterial) {
    stainlessMaterial = new MeshStandardMaterial({
      map: textures.stainless(),
      normalMap: textures.stainlessNormal(),
      normalScale: new Vector2(0.7, 0.7),
      roughness: 0.34,
      metalness: 0.4,
      vertexColors: true,
      envMapIntensity: 0.9,
    });
  }
  return stainlessMaterial;
}

/** Bogies, underframe equipment and everything else painted dark below the floor. */
let underframeMaterial: MeshStandardMaterial | null = null;
export function getUnderframeMaterial(): MeshStandardMaterial {
  if (!underframeMaterial) {
    underframeMaterial = new MeshStandardMaterial({
      map: textures.steel(),
      roughness: 0.72,
      metalness: 0.55,
      vertexColors: true,
      envMapIntensity: 0.6,
    });
  }
  return underframeMaterial;
}

/** Body panel material for rolling stock: painted metal with clear coat. */
export function createBodyMaterial(color: number, roughness = 0.34): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0.12,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    // Painted bodyside, not a mirror: too much environment blows the whites out.
    envMapIntensity: 0.55,
  });
}

/** Unlit material for lamps, blinds and signal lenses. */
export function createEmissiveMaterial(color: number, intensity = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), fog: true });
}

export function disposeMaterials(): void {
  simpleCache.clear();
  texturedCache.clear();
}
