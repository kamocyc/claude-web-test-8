/**
 * GLSL fragments shared by the post-processing passes.
 *
 * Everything here is procedural: the project ships no art assets, so the
 * dither pattern, the grain and the lens dirt are all functions rather than
 * textures.
 */

/** Standard fullscreen-triangle vertex shader used by every custom pass. */
export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * View-space position reconstruction from a hardware depth buffer.
 *
 * `uInvProjection` is the inverse of the camera projection matrix; feeding the
 * clip-space point straight back through it is exact for any projection, which
 * matters here because the camera's near plane is 12 cm and its far plane can
 * be eight kilometres away.
 */
export const DEPTH_UTILS = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uInvProjection;
  uniform vec2 uCameraRange; // near, far

  float rawDepth(vec2 uv) {
    return texture2D(tDepth, uv).x;
  }

  vec3 viewPosFromDepth(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInvProjection * clip;
    return view.xyz / view.w;
  }

  vec3 viewPosAt(vec2 uv) {
    return viewPosFromDepth(uv, rawDepth(uv));
  }

  /** Positive distance along -Z. Far-plane samples come back as uCameraRange.y. */
  float linearDepth(float depth) {
    float ndc = depth * 2.0 - 1.0;
    float n = uCameraRange.x;
    float f = uCameraRange.y;
    return (2.0 * n * f) / (f + n - ndc * (f - n));
  }

  /**
   * The sky dome writes no depth, so sky pixels keep the cleared value of one.
   * The test has to be this tight: with a 12 cm near plane and a far plane
   * kilometres away, a depth of 0.9999 is still only a kilometre out.
   */
  bool isSky(float depth) {
    return depth > 0.999995;
  }
`;

/**
 * Interleaved gradient noise - Jorge Jimenez's dither. One multiply-add and a
 * fract, and it decorrelates far better across neighbouring pixels than a hash
 * does, which is what makes a twelve-tap occlusion kernel resolve cleanly.
 */
export const NOISE_UTILS = /* glsl */ `
  float interleavedGradientNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

export const LUMINANCE = /* glsl */ `
  // Named to stay clear of the luminance() three.js injects into every program.
  float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
