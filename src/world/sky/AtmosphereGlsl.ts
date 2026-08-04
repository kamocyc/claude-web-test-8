/**
 * Shared GLSL for the atmosphere model.
 *
 * A Bruneton/Hillaire style single + multiple scattering model, evaluated into
 * small look-up tables at run time rather than shipped as data. Rayleigh and
 * Mie scattering with ozone absorption, in kilometre units on a spherical
 * planet, so the sky is orange at the horizon and deep blue overhead because
 * the optical depths say so.
 *
 * Three tables:
 *   transmittance  (height, sun cosine)      - baked once
 *   multiScatter   (height, sun cosine)      - baked once
 *   skyView        (azimuth-from-sun, pitch) - rebaked when the sun moves
 *
 * The sky-view table stores everything except the Mie single-scattering phase
 * so the sharp glow around the sun can be reconstructed at full resolution
 * from a table only a hundred texels wide.
 */

/**
 * The direction/table mapping on its own. The aerial perspective injected into
 * every surface material needs this and nothing else, so it is kept free of
 * uniform declarations.
 */
export const SKY_MAPPING_GLSL = /* glsl */ `
#ifndef SKY_PI
#define SKY_PI 3.141592653589793
#endif

/**
 * Sky-view table: horizontal angle measured away from the sun (the atmosphere
 * is symmetric about the sun/zenith plane so half a turn is enough) against a
 * square-root warped pitch that spends its resolution near the horizon, where
 * all the interesting gradients are.
 */
vec2 skyViewUv(vec3 dir, vec3 sunDir, vec2 texel) {
  vec2 dh = vec2(dir.x, dir.z);
  vec2 sh = vec2(sunDir.x, sunDir.z);
  float dl = length(dh);
  float sl = length(sh);
  float cosAzimuth = (dl > 1e-5 && sl > 1e-5) ? dot(dh, sh) / (dl * sl) : 1.0;
  float azimuth = acos(clamp(cosAzimuth, -1.0, 1.0)) / SKY_PI;
  float l = clamp(dir.y, -1.0, 1.0);
  float v = 0.5 + 0.5 * sign(l) * sqrt(abs(l));
  vec2 p = vec2(azimuth, v);
  return p * (1.0 - texel) + 0.5 * texel;
}

float skyHgPhase(float c, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * SKY_PI * d * sqrt(max(d, 1e-4)));
}

/**
 * Rebuilds sky radiance in a direction from the table: everything but the Mie
 * single-scattering lobe comes from the texels, the lobe itself is evaluated
 * per pixel so the glow around a low sun stays sharp.
 */
vec3 skyRadiance(sampler2D lut, vec2 texel, vec3 dir, vec3 sunDir, vec3 sunTint) {
  vec4 s = texture2D(lut, skyViewUv(dir, sunDir, texel));
  float c = dot(dir, sunDir);
  return s.rgb + s.a * skyHgPhase(c, 0.76) * sunTint;
}
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

const float GROUND_RADIUS = 6360.0;
const float ATMO_RADIUS = 6460.0;
const float ATMO_THICKNESS = 100.0;

const vec3 RAYLEIGH_SCATTER = vec3(5.802, 13.558, 33.100) * 1e-3;
const float MIE_SCATTER = 3.996e-3;
const float MIE_ABSORB = 4.40e-3;
const vec3 OZONE_ABSORB = vec3(0.650, 1.881, 0.085) * 1e-3;

uniform float uTurbidity;
uniform float uGroundAlbedo;

void sampleMedium(float h, out vec3 scatterR, out float scatterM, out vec3 extinction) {
  float rayleighDensity = exp(-max(h, 0.0) / 8.0);
  // Turbidity thickens the aerosol layer; a hazy summer afternoon and a crisp
  // winter morning differ almost entirely in this one number.
  float mieDensity = exp(-max(h, 0.0) / 1.2) * uTurbidity;
  scatterR = RAYLEIGH_SCATTER * rayleighDensity;
  scatterM = MIE_SCATTER * mieDensity;
  vec3 ozone = OZONE_ABSORB * max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  extinction = scatterR + vec3(scatterM + MIE_ABSORB * mieDensity) + ozone;
}

/** Nearest positive intersection of a ray from \`ro\` with a sphere at the origin. */
float raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  float t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

float rayleighPhase(float c) {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

vec2 transmittanceUv(float h, float mu, vec2 texel) {
  vec2 p = vec2(clamp(0.5 + 0.5 * mu, 0.0, 1.0), clamp(h / ATMO_THICKNESS, 0.0, 1.0));
  return p * (1.0 - texel) + 0.5 * texel;
}

void transmittanceParams(vec2 uv, vec2 texel, out float h, out float mu) {
  vec2 p = clamp((uv - 0.5 * texel) / (1.0 - texel), 0.0, 1.0);
  mu = p.x * 2.0 - 1.0;
  h = p.y * ATMO_THICKNESS;
}
`;

/** Helpers that need the baked transmittance table bound. */
export const ATMOSPHERE_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uTransmittanceLut;
uniform vec2 uTransmittanceTexel;

vec3 sunTransmittance(float h, float mu) {
  return texture2D(uTransmittanceLut, transmittanceUv(h, mu, uTransmittanceTexel)).rgb;
}
`;
