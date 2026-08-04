/**
 * The night half of the dome: stars by magnitude and spectral class, the Milky
 * Way, and a moon with a real phase and a procedurally cratered surface.
 *
 * Everything is evaluated straight from the view direction, so it costs nothing
 * when the sun is up (the whole block sits behind a branch on sky brightness).
 */
export const NIGHT_GLSL = /* glsl */ `

float nHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float nHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float nNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = nHash(i);
  float n100 = nHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = nHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = nHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = nHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = nHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = nHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = nHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float nFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * nNoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

/** Warm dwarfs through to hot blue-white giants. */
vec3 starColour(float x) {
  vec3 cool = vec3(1.0, 0.58, 0.36);
  vec3 mid = vec3(1.0, 0.95, 0.88);
  vec3 hot = vec3(0.70, 0.79, 1.0);
  return x < 0.5 ? mix(cool, mid, x * 2.0) : mix(mid, hot, (x - 0.5) * 2.0);
}

/** Cube-face grid so star density is even instead of piling up at the zenith. */
void cubeFace(vec3 dir, out vec2 uv, out float face) {
  vec3 a = abs(dir);
  float m = max(a.x, max(a.y, a.z));
  if (a.x >= m) { uv = dir.zy / a.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= m) { uv = dir.xz / a.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
  else { uv = dir.xy / a.z; face = dir.z > 0.0 ? 4.0 : 5.0; }
}

vec3 starLayer(vec2 uv, float face, float cells, float density, float scale, float time, float galactic) {
  vec2 p = uv * cells;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float seed = nHash2(cell + face * 71.3);
  float threshold = 1.0 - density * (1.0 + galactic * 2.2);
  if (seed < threshold) return vec3(0.0);

  float rx = nHash2(cell + face * 13.1 + 5.7);
  float ry = nHash2(cell + face * 29.7 + 91.3);
  vec2 star = vec2(0.15 + rx * 0.7, 0.15 + ry * 0.7);
  float d = length(f - star);

  // Magnitude: a steep power law, so most stars are faint and a very few are
  // first magnitude. Points of light, not blobs - a star is a point source and
  // the moment it has visible area the sky stops reading as a sky.
  float mag = pow(nHash2(cell + face * 3.3 + 17.9), 4.2);
  float radius = (0.010 + mag * 0.030) * scale;
  float core = smoothstep(radius, 0.0, d);
  float halo = smoothstep(radius * 3.2, 0.0, d) * 0.10;

  float twinkle = 0.72 + 0.28 * sin(time * (1.3 + seed * 3.1) + seed * 60.0);
  vec3 colour = starColour(nHash2(cell + face * 47.1 + 3.1));
  return colour * (core + halo) * (0.16 + mag * 2.6) * twinkle;
}

/**
 * The Milky Way: a great circle band of unresolved starlight, cut by dust
 * lanes. The pole vector tilts it so it does not sit flat on the horizon.
 */
vec3 milkyWay(vec3 dir, vec3 pole, out float density) {
  float b = dot(dir, pole);
  float band = exp(-b * b * 26.0);
  vec3 q = dir * 6.0;
  float clouds = nFbm(q * 1.7);
  float dust = nFbm(q * 3.3 + 11.0);
  float lane = smoothstep(0.30, 0.62, dust);
  float bright = band * (0.35 + clouds * 1.25) * mix(0.35, 1.0, lane);
  density = band * clouds;
  vec3 tint = mix(vec3(0.62, 0.70, 0.95), vec3(1.0, 0.93, 0.80), clouds * 0.7);
  return tint * bright;
}

/**
 * The moon. Its own direction, lit by the real sun direction, so the phase and
 * the tilt of the terminator come out right for free.
 */
vec3 moonDisc(vec3 dir, vec3 moonDir, vec3 sunDir, float radius, out float mask) {
  mask = 0.0;
  float c = dot(dir, moonDir);
  float cosR = cos(radius);
  vec3 result = vec3(0.0);

  // Glow around the moon: light scattered by the air near a bright source.
  float glow = pow(max(c, 0.0), 2400.0) * 0.55 + pow(max(c, 0.0), 160.0) * 0.05;
  result += vec3(0.55, 0.62, 0.85) * glow;

  if (c > cosR - 0.0002) {
    vec3 f = moonDir;
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-5));
    vec3 up = cross(f, right);
    vec2 p = vec2(dot(dir, right), dot(dir, up)) / sin(radius);
    float rr = dot(p, p);
    float edge = 0.018;
    float disc = smoothstep(1.0 + edge, 1.0 - edge, rr);
    if (disc > 0.0) {
      vec3 n = normalize(f * sqrt(max(0.0, 1.0 - min(rr, 1.0))) + right * p.x + up * p.y);
      // Maria: broad dark basalt plains.
      float maria = nFbm(n * 2.4 + 4.0);
      float albedo = mix(0.055, 0.14, smoothstep(0.42, 0.60, maria));
      // Craters: bright rims, darker floors, plus a bright ray system.
      float cr = nFbm(n * 13.0);
      albedo *= 0.78 + 0.55 * cr;
      float rays = smoothstep(0.62, 0.95, nFbm(n * 5.0 + 20.0));
      albedo += rays * 0.035;

      float ndl = dot(n, sunDir);
      // Lommel-Seeliger: the moon is a retroreflector, so it stays flat and
      // bright right out to the limb instead of falling off like a ball.
      float lit = max(0.0, ndl) / (max(0.0, ndl) + 0.28);
      float term = smoothstep(-0.06, 0.10, ndl);
      result += vec3(1.0, 0.975, 0.93) * albedo * lit * term * disc * 42.0;
      // Earthshine on the dark limb.
      result += vec3(0.35, 0.42, 0.6) * albedo * (1.0 - term) * disc * 0.9;
      mask = disc;
    }
  }
  return result;
}
`;
