import type { IUniform } from 'three';
import { Vector2 } from 'three';

/**
 * Final image grade applied after tone mapping.
 *
 * Cheap effects that sell the "shot through a windscreen with a real lens"
 * look: barrel-weighted chromatic aberration, vignetting, film grain, a subtle
 * lift/gain split-tone and a windscreen glare gradient.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.9 },
    uSaturation: { value: 1.14 },
    uContrast: { value: 1.07 },
    uGlare: { value: 0.0 },
    uWet: { value: 0.0 },
  } as Record<string, IUniform>,

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uGlare;
    uniform float uWet;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float r2 = dot(center, center);

      // Lateral chromatic aberration grows towards the frame edges.
      float amount = uAberration * 0.0016 * r2;
      vec3 color;
      color.r = texture2D(tDiffuse, uv - center * amount).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + center * amount).b;

      // Split tone: cool shadows, warm highlights.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(color, color * vec3(0.96, 0.99, 1.06), (1.0 - luma) * 0.35);
      color = mix(color, color * vec3(1.04, 1.005, 0.96), luma * 0.30);

      color = mix(vec3(luma), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      // Windscreen glare: a soft wedge of scattered light from the sun.
      color += uGlare * smoothstep(0.75, 0.0, distance(uv, vec2(0.5, 0.92))) * vec3(1.0, 0.94, 0.82) * 0.16;

      // Grease/rain smear on the glass, strongest at the frame edges.
      if (uWet > 0.001) {
        float smear = hash12(floor(uv * vec2(90.0, 40.0)));
        color += uWet * 0.05 * smear * smoothstep(0.05, 0.35, r2);
      }

      float vig = smoothstep(0.95, 0.18, r2 * 1.9);
      color *= mix(1.0, vig, uVignette);

      float grain = hash12(gl_FragCoord.xy + fract(uTime) * 431.7) - 0.5;
      color += grain * uGrain * (1.15 - luma * 0.7);

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};
