import type { IUniform } from 'three';
import { Color, Vector2, Vector3 } from 'three';

/**
 * Exposure, tone mapping and the final grade.
 *
 * This pass ends the linear part of the pipeline: everything upstream of it is
 * scene-referred HDR, everything downstream is display-referred sRGB. It
 * therefore also replaces `OutputPass`, which is why the sRGB transfer function
 * is written out by hand at the bottom - putting `OutputPass` in front of a
 * grade meant grading tone-mapped, already-encoded pixels, and the two curves
 * fought each other.
 *
 * The tone curve is AgX rather than ACES. ACES is what was here, and its
 * notorious failure is exactly this game's subject matter: it swings saturated
 * warm highlights towards orange and then towards white, so a low sun over a
 * green landscape came out as a pale yellow wash with no hue left in it. AgX
 * spends far longer in the shoulder and keeps hue while it desaturates, which
 * is what makes a sunset read as a sunset.
 *
 * On top of the curve sits a proper grade - ASC CDL slope/offset/power, split
 * toning, a filmic contrast pivot and saturation shaping - all driven from the
 * time of day, so dawn is cool and blue, evening is gold, overcast is flat and
 * desaturated and night is crushed and cold.
 */
export const GradeShader = {
  name: 'GradeShader',

  defines: {
    AUTO_EXPOSURE: 1,
  } as Record<string, unknown>,

  uniforms: {
    tDiffuse: { value: null },
    tExposure: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },

    uExposure: { value: 0.9 },
    uExposureBias: { value: 1 },

    /** ASC CDL: colour * slope + offset, then raised to power. */
    uSlope: { value: new Vector3(1, 1, 1) },
    uOffset: { value: new Vector3(0, 0, 0) },
    uPower: { value: new Vector3(1, 1, 1) },

    uContrast: { value: 1.06 },
    // Middle grey in the display-linear space AgX hands back, not 0.5: pivot
    // any higher and raising contrast quietly darkens the whole mid-tone.
    uContrastPivot: { value: 0.18 },
    uSaturation: { value: 1.08 },
    /** Extra saturation applied only to already-dull colours. */
    uVibrance: { value: 0.18 },

    uShadowTint: { value: new Color(0.86, 0.94, 1.1) },
    uHighlightTint: { value: new Color(1.06, 1.0, 0.92) },
    uToneBalance: { value: 0.0 },

    uVignette: { value: 0.33 },
    uVignetteRoundness: { value: 1.0 },
    uGrain: { value: 0.03 },
    uAberration: { value: 0.85 },
    uGlare: { value: 0.0 },
    uWet: { value: 0.0 },
    uSunUv: { value: new Vector2(0.5, 0.5) },
    uDirt: { value: 0.0 },
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
    uniform sampler2D tExposure;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uExposure;
    uniform float uExposureBias;
    uniform vec3 uSlope;
    uniform vec3 uOffset;
    uniform vec3 uPower;
    uniform float uContrast;
    uniform float uContrastPivot;
    uniform float uSaturation;
    uniform float uVibrance;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uToneBalance;
    uniform float uVignette;
    uniform float uVignetteRoundness;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uGlare;
    uniform float uWet;
    uniform vec2 uSunUv;
    uniform float uDirt;
    varying vec2 vUv;

    // Named to stay clear of the luminance() three.js injects into every program.
  float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // --- AgX -------------------------------------------------------------
    const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
      vec3(0.6274, 0.0691, 0.0164),
      vec3(0.3293, 0.9195, 0.0880),
      vec3(0.0433, 0.0113, 0.8956)
    );
    const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
      vec3( 1.6605, -0.1246, -0.0182),
      vec3(-0.5876,  1.1329, -0.1006),
      vec3(-0.0728, -0.0083,  1.1187)
    );
    const mat3 AgXInsetMatrix = mat3(
      vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
      vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
      vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
    );
    const mat3 AgXOutsetMatrix = mat3(
      vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
      vec3(-0.11060664309660323,  1.157823702216272, -0.11060664309660294),
      vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
    );
    const float AgxMinEv = -12.47393;
    const float AgxMaxEv = 4.026069;

    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
           - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }

    vec3 agx(vec3 color) {
      color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
      color = AgXInsetMatrix * color;
      color = max(color, 1e-10);
      color = (log2(color) - AgxMinEv) / (AgxMaxEv - AgxMinEv);
      color = clamp(color, 0.0, 1.0);
      color = agxContrast(color);
      color = AgXOutsetMatrix * color;
      color = pow(max(color, vec3(0.0)), vec3(2.2));
      color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
      return max(color, vec3(0.0));
    }

    vec3 linearToSrgb(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c));
    }

    void main() {
      vec2 uv = vUv;
      vec2 centre = uv - 0.5;
      float r2 = dot(centre, centre);

      // Lateral chromatic aberration, quadratic towards the frame edges. Done
      // in three taps on the HDR image so it survives tone mapping rather than
      // fringing the already-clipped result.
      float amount = uAberration * 0.0018 * r2;
      vec3 color;
      color.r = texture2D(tDiffuse, uv - centre * amount).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + centre * amount).b;
      color = max(color, vec3(0.0));

      float exposure = uExposure;
      #if AUTO_EXPOSURE
      float metered = texture2D(tExposure, vec2(0.5)).r;
      // The range test also rejects NaN, which a plain greater-than-zero test
      // would silently let through.
      exposure = (metered > 0.02 && metered < 40.0) ? metered : uExposure;
      #endif
      color *= exposure * uExposureBias;

      // Sun glare on the glass: scattered light from a bright source outside
      // the lens, added before the curve so it rolls off with everything else.
      if (uGlare > 0.002) {
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        vec2 d = (uv - uSunUv) * vec2(aspect, 1.0);
        float wedge = exp(-length(d) * 3.6);
        // A little smooth streaking across the glass, so the wash is not a
        // perfectly clean radial gradient. An earlier version quantised a hash
        // into cells for this and the result was visibly blocky, which is far
        // worse than no structure at all.
        float smear = 0.85 + 0.15 * sin(uv.y * 47.0 + uv.x * 11.0);
        color += vec3(1.0, 0.94, 0.82) * uGlare * wedge * smear * (0.10 + uDirt * 0.14);
      }

      color = agx(color);

      // --- grade ---------------------------------------------------------
      // ASC CDL.
      color = max(color * uSlope + uOffset, vec3(0.0));
      color = pow(color, uPower);

      // Contrast about middle grey rather than 0.5. AgX returns
      // display-linear values, where middle grey sits at 0.18, so pivoting
      // where a naive grade would puts a third of a stop of unintended
      // darkening across everything.
      color = max(
        (color - uContrastPivot) * uContrast + uContrastPivot,
        vec3(0.0)
      );

      float luma = lumaOf(color);

      // Split tone: the shadow and highlight tints cross over at mid grey,
      // offset by the balance control.
      float shadowW = 1.0 - smoothstep(0.0, 0.55 + uToneBalance, luma);
      float highW = smoothstep(0.35 + uToneBalance, 1.0, luma);
      color *= mix(vec3(1.0), uShadowTint, shadowW * 0.75);
      color *= mix(vec3(1.0), uHighlightTint, highW * 0.75);

      // Saturation, then vibrance: vibrance lifts only the colours that are
      // already dull, which keeps skin-tone-ish browns and rail rust alive
      // without turning the grass into poster paint.
      luma = lumaOf(color);
      color = mix(vec3(luma), color, uSaturation);
      float chroma = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
      color = mix(vec3(lumaOf(color)), color, 1.0 + uVibrance * (1.0 - smoothstep(0.0, 0.4, chroma)));

      // Rain and grease smear on the glass.
      if (uWet > 0.001) {
        float smear = hash12(floor(uv * vec2(90.0, 40.0)));
        color += uWet * 0.035 * smear * smoothstep(0.05, 0.35, r2);
      }

      // Vignette: a soft, slightly non-circular falloff, the way a real
      // wide-angle lens darkens the corners.
      vec2 vd = centre * vec2(mix(1.0, uResolution.x / max(uResolution.y, 1.0), uVignetteRoundness), 1.0);
      float vig = smoothstep(1.05, 0.22, dot(vd, vd) * 1.75);
      color *= mix(1.0, vig, uVignette);

      color = linearToSrgb(color);

      // Filmic grain: animated, weighted towards the mid-tones and shadows the
      // way silver halide is, and applied after the transfer function so it
      // reads at the same strength across the whole range.
      if (uGrain > 0.0001) {
        vec2 gp = gl_FragCoord.xy + vec2(fract(uTime * 13.0) * 431.7, fract(uTime * 7.0) * 917.3);
        // Two hashes make a triangular distribution, which dithers banding out
        // instead of adding a uniform fizz.
        float n = hash12(gp) + hash12(gp + 19.7) - 1.0;
        float weight = 1.0 - abs(lumaOf(color) - 0.35) * 1.1;
        color += n * uGrain * max(weight, 0.15);
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
