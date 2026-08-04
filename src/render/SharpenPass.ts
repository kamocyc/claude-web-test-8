import type { IUniform } from 'three';
import { Vector2 } from 'three';

/**
 * Robust contrast-adaptive sharpening, run after antialiasing.
 *
 * SMAA works by finding edges and blending across them, which is exactly what
 * saves the catenary from crawling and exactly what makes a rail head look
 * like a smudge. AMD's RCAS is the standard answer: it sharpens by an amount
 * derived from the local minimum and maximum, so flat areas - sky, ballast,
 * grass - are left alone and only real edges get their contrast back. Because
 * the gain is clamped by the neighbourhood it cannot ring, which an unsharp
 * mask on a frame full of thin wires certainly would.
 *
 * It runs on the graded, sRGB-encoded image, which is where RCAS is meant to
 * work: sharpening in scene-linear over-weights highlights.
 */
export const SharpenShader = {
  name: 'SharpenShader',

  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new Vector2(1 / 1920, 1 / 1080) },
    /** 0 = off, 1 = maximum. About 0.35 is as far as this content wants. */
    uSharpness: { value: 0.35 },
  } as Record<string, IUniform>,

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uSharpness;
    varying vec2 vUv;

    void main() {
      vec3 e = texture2D(tDiffuse, vUv).rgb;
      if (uSharpness <= 0.001) { gl_FragColor = vec4(e, 1.0); return; }

      vec3 b = texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y)).rgb;
      vec3 d = texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0)).rgb;
      vec3 f = texture2D(tDiffuse, vUv + vec2( uTexel.x, 0.0)).rgb;
      vec3 h = texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y)).rgb;

      vec3 mn = min(min(min(d, e), min(f, b)), h);
      vec3 mx = max(max(max(d, e), max(f, b)), h);

      // How much headroom this pixel has before the sharpened result would
      // clip or crush; the sharpening strength follows it, which is what makes
      // the filter ring-free.
      vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0);
      amp = sqrt(amp);

      float peak = -1.0 / mix(8.0, 5.0, uSharpness);
      vec3 w = amp * peak;
      vec3 result = (b + d + f + h) * w + e;
      result /= (4.0 * w + 1.0);

      gl_FragColor = vec4(clamp(mix(e, result, uSharpness * 2.4), 0.0, 1.0), 1.0);
    }
  `,
};
