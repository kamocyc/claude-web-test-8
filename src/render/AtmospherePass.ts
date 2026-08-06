import {
  Color,
  Matrix4,
  NoBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { DEPTH_UTILS, FULLSCREEN_VERTEX, LUMINANCE, NOISE_UTILS } from './ShaderChunks';

/**
 * The depth-aware composite: ambient occlusion, aerial perspective, god rays
 * and the veiling glare of a lens pointed near the sun. All of them need the
 * depth of the frame, so they share one pass and one set of texture reads.
 *
 * Aerial perspective is the part that does the most work for the picture. The
 * scene's exponential fog already fades distance towards a single horizon
 * colour, which is flat and grey; what real air does is scatter *directionally*
 * - hills between you and the sun glow warm and bright, hills with the sun
 * behind you go blue and cold. Splitting the haze into a Rayleigh term
 * (isotropic, blue, dominant away from the sun) and a Mie term (forward
 * scattering, warm, dominant towards it) is what makes distance read as air
 * rather than as fade-to-grey.
 */
export class AtmospherePass extends Pass {
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  aoTexture: Texture | null = null;
  depthTexture: Texture | null = null;
  godRayTexture: Texture | null = null;

  constructor() {
    super();
    this.material = new ShaderMaterial({
      defines: { USE_AO: 0, USE_GODRAYS: 0 },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tAO: { value: null },
        tGodRays: { value: null },
        uInvProjection: { value: new Matrix4() },
        uCameraRange: { value: new Vector2(0.1, 1000) },
        uViewToWorld: { value: new Matrix4() },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(1, 1, 1) },
        uHazeColor: { value: new Color(0.6, 0.72, 0.88) },
        uZenithColor: { value: new Color(0.1, 0.22, 0.5) },
        uRayleigh: { value: 0.00042 },
        uMie: { value: 0.00016 },
        uAoStrength: { value: 0.85 },
        uAoTint: { value: new Vector3(1.05, 1.0, 0.88) },
        uGodRayStrength: { value: 0 },
        uSunUv: { value: new Vector2(0.5, 0.5) },
        uGlare: { value: 0 },
        uGlareTint: { value: new Color(1, 0.92, 0.78) },
        uAspect: { value: 1.777 },
        uDaylight: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${DEPTH_UTILS}
        ${NOISE_UTILS}
        ${LUMINANCE}
        uniform sampler2D tDiffuse;
        uniform sampler2D tAO;
        uniform sampler2D tGodRays;
        uniform mat4 uViewToWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHazeColor;
        uniform vec3 uZenithColor;
        uniform float uRayleigh;
        uniform float uMie;
        uniform float uAoStrength;
        uniform vec3 uAoTint;
        uniform float uGodRayStrength;
        uniform vec2 uSunUv;
        uniform float uGlare;
        uniform vec3 uGlareTint;
        uniform float uAspect;
        uniform float uDaylight;
        varying vec2 vUv;

        // Henyey-Greenstein, the standard forward-scattering phase function.
        float henyeyGreenstein(float cosTheta, float g) {
          float g2 = g * g;
          float d = 1.0 + g2 - 2.0 * g * cosTheta;
          return (1.0 - g2) / (12.566371 * max(d * sqrt(max(d, 1e-4)), 1e-4));
        }

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          float depth = rawDepth(vUv);
          vec3 viewPos = viewPosFromDepth(vUv, depth);
          vec3 worldDir = normalize((uViewToWorld * vec4(viewPos, 0.0)).xyz);
          float cosTheta = dot(worldDir, uSunDir);

          #if USE_AO
          {
            float ao = texture2D(tAO, vUv).r;
            // Occlusion belongs to indirect light, so ease it off where the
            // pixel is clearly in direct sun; otherwise sunlit ballast turns
            // to mud under the sleepers.
            float lit = smoothstep(0.35, 1.6, lumaOf(color));
            float k = uAoStrength * mix(1.0, 0.5, lit);
            // Capped: occlusion is a shading cue, and a crevice that goes to
            // pure black reads as a hole in the geometry.
            float occluded = min((1.0 - ao) * k, 0.55);
            // What a crevice loses is *sky* light, so it loses more red than
            // blue and the shadow ends up cool rather than grey. Written as an
            // absorption of the occluded fraction so that a fully open pixel
            // is left exactly as it was - tinting the whole multiplier, which
            // is the obvious way to write this, puts a blue cast over the
            // entire frame.
            vec3 absorb = vec3(1.0) - occluded * uAoTint;
            color *= max(absorb, vec3(0.0));
          }
          #endif

          if (!isSky(depth)) {
            float dist = length(viewPos);

            // Two-term aerial perspective. Rayleigh is isotropic and blue; Mie
            // is warm and piles up towards the sun.
            float rayleighT = 1.0 - exp(-dist * uRayleigh);
            float mieT = 1.0 - exp(-dist * uMie);
            float phase = henyeyGreenstein(cosTheta, 0.6) * 12.566371;

            // The scene's own exponential fog already fades distance towards
            // the horizon colour, so the isotropic term here is deliberately
            // slight - all it has to do is bend that fade towards the blue of
            // the sky above the horizon. The directional term is the one that
            // earns its keep.
            vec3 skyTint = mix(uHazeColor, uZenithColor, 0.3 + 0.4 * max(worldDir.y, 0.0));
            vec3 inscatter = skyTint * rayleighT * 0.5;
            inscatter += uSunColor * uHazeColor * mieT * phase * 0.16;

            float extinction = exp(-dist * (uRayleigh * 0.5 + uMie * 0.3));
            color = color * mix(1.0, extinction, 0.4) + inscatter * uDaylight;
          }

          #if USE_GODRAYS
          if (uGodRayStrength > 0.001) {
            vec3 shafts = texture2D(tGodRays, vUv).rgb;
            color += shafts * uGodRayStrength * uSunColor;
          }
          #endif

          // Veiling glare: the low-frequency wash a real lens throws across the
          // frame when the sun is anywhere near the front element, plus one
          // restrained anamorphic streak. Kept well under the bloom so it reads
          // as glass, not as a filter.
          if (uGlare > 0.002) {
            vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
            float r = length(d);
            float veil = exp(-r * 3.8) * 0.38 + exp(-r * 1.3) * 0.075;
            // One restrained anamorphic streak. Discrete lens ghosts were
            // tried and thrown out: as soon as they are visible at all they
            // read as blobs painted on the frame rather than as glass.
            float streak = exp(-abs(d.x) * 2.4) * exp(-abs(d.y) * 110.0) * 0.32;
            color += uGlareTint * uGlare * (veil + streak);
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get uniforms() {
    return this.material.uniforms;
  }

  setFeatures(ao: boolean, godRays: boolean): void {
    const nextAo = ao ? 1 : 0;
    const nextRays = godRays ? 1 : 0;
    if (this.material.defines.USE_AO === nextAo && this.material.defines.USE_GODRAYS === nextRays) {
      return;
    }
    this.material.defines.USE_AO = nextAo;
    this.material.defines.USE_GODRAYS = nextRays;
    this.material.needsUpdate = true;
  }

  override setSize(width: number, height: number): void {
    this.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = this.depthTexture;
    u.tAO.value = this.aoTexture;
    u.tGodRays.value = this.godRayTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
