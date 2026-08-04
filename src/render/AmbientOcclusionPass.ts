import {
  ClampToEdgeWrapping,
  LinearFilter,
  Matrix4,
  NoBlending,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { DEPTH_UTILS, FULLSCREEN_VERTEX, NOISE_UTILS } from './ShaderChunks';

/**
 * Ground-truth-flavoured screen space ambient occlusion.
 *
 * The estimator is the Alchemy/scalable-obscurance one: sample a spiral of
 * neighbours, ask each how far it rises above the tangent plane of the shaded
 * point, and fold that into a visibility term. Compared with a plain
 * hemisphere test it stays stable at grazing angles, and a train sim is
 * nothing but grazing angles - rails, ballast shoulders and platform edges all
 * run away from the camera almost flat.
 *
 * Normals come out of the depth buffer rather than a G-buffer: the world has no
 * normal pass and adding one would double the draw calls. The four-tap "pick
 * the closer neighbour" trick keeps the reconstructed normal from smearing
 * across silhouettes, which is where a naive derivative normal produces the
 * dark halos that give cheap SSAO away.
 *
 * Occlusion is written at half resolution and then blurred with a depth-aware
 * cross, so it never bleeds across a foreground edge.
 */
export class AmbientOcclusionPass extends Pass {
  private targetA: WebGLRenderTarget;
  private targetB: WebGLRenderTarget;
  private readonly aoMaterial: ShaderMaterial;
  private readonly blurMaterial: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly invProjection = new Matrix4();

  /** Fraction of full resolution the occlusion buffer runs at. */
  scale = 0.5;
  /** Number of spiral samples. */
  samples = 12;

  constructor(private camera: PerspectiveCamera) {
    super();
    this.needsSwap = false;

    const options = {
      type: UnsignedByteType,
      format: RedFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;
    this.targetA = new WebGLRenderTarget(1, 1, options);
    this.targetB = new WebGLRenderTarget(1, 1, options);

    this.aoMaterial = new ShaderMaterial({
      defines: { SAMPLES: 12 },
      uniforms: {
        tDepth: { value: null },
        uInvProjection: { value: new Matrix4() },
        uCameraRange: { value: new Vector2(0.1, 1000) },
        uResolution: { value: new Vector2(1, 1) },
        uRadius: { value: 0.85 },
        uIntensity: { value: 1.0 },
        uBias: { value: 0.035 },
        uMaxDistance: { value: 220 },
        uProjScale: { value: 500 },
        uFrame: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2D;
        ${DEPTH_UTILS}
        ${NOISE_UTILS}
        uniform vec2 uResolution;
        uniform float uRadius;
        uniform float uIntensity;
        uniform float uBias;
        uniform float uMaxDistance;
        uniform float uProjScale;
        uniform float uFrame;
        varying vec2 vUv;

        // Reconstruct a view-space normal, choosing the nearer of each pair of
        // neighbours so silhouettes do not drag the plane with them.
        vec3 normalFromDepth(vec2 uv, vec3 p) {
          vec2 texel = 1.0 / uResolution;
          vec3 l = viewPosAt(uv - vec2(texel.x, 0.0));
          vec3 r = viewPosAt(uv + vec2(texel.x, 0.0));
          vec3 d = viewPosAt(uv - vec2(0.0, texel.y));
          vec3 u = viewPosAt(uv + vec2(0.0, texel.y));
          vec3 dx = abs(l.z - p.z) < abs(r.z - p.z) ? (p - l) : (r - p);
          vec3 dy = abs(d.z - p.z) < abs(u.z - p.z) ? (p - d) : (u - p);
          return normalize(cross(dx, dy));
        }

        void main() {
          float depth = rawDepth(vUv);
          if (isSky(depth)) { gl_FragColor = vec4(1.0); return; }

          vec3 p = viewPosFromDepth(vUv, depth);
          float dist = -p.z;
          // Beyond a few hundred metres the radius is under a pixel and all the
          // samples land on the same texel, so fade the effect out instead of
          // paying for noise.
          float range = 1.0 - smoothstep(uMaxDistance * 0.55, uMaxDistance, dist);
          if (range <= 0.001) { gl_FragColor = vec4(1.0); return; }

          vec3 n = normalFromDepth(vUv, p);

          // Screen-space radius of the world-space sampling sphere.
          float radiusPixels = uProjScale * uRadius / max(dist, 0.05);
          radiusPixels = min(radiusPixels, uResolution.y * 0.16);
          if (radiusPixels < 1.2) { gl_FragColor = vec4(1.0); return; }

          float rotation = interleavedGradientNoise(gl_FragCoord.xy + uFrame * 5.588238) * 6.2831853;
          const float spiralTurns = 7.0;
          float sum = 0.0;

          for (int i = 0; i < SAMPLES; i++) {
            float t = (float(i) + 0.5) / float(SAMPLES);
            float angle = t * spiralTurns * 6.2831853 + rotation;
            float r = radiusPixels * t;
            vec2 offset = vec2(cos(angle), sin(angle)) * r / uResolution;
            vec2 sampleUv = vUv + offset;
            if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

            float sd = rawDepth(sampleUv);
            if (isSky(sd)) continue;
            vec3 q = viewPosFromDepth(sampleUv, sd);
            // Anything far in front of the shaded point in depth is a
            // different surface entirely, not an occluder. Without this test a
            // near silhouette - a cab pillar, a mast - paints a dark halo onto
            // whatever is behind it.
            if (abs(q.z - p.z) > uRadius * 2.5) continue;
            vec3 v = q - p;
            float vv = dot(v, v);
            float vn = dot(v, n);
            // Alchemy obscurance with a smooth range cut so a distant wall
            // behind a foreground edge cannot punch a halo into it.
            float falloff = 1.0 - smoothstep(uRadius * 0.75, uRadius * 1.4, sqrt(vv));
            sum += falloff * max(vn - dist * 0.0012 - uBias, 0.0) / (vv + 0.02);
          }

          float ao = max(0.0, 1.0 - (2.0 * uIntensity / float(SAMPLES)) * sum);
          ao = pow(ao, 1.6);
          gl_FragColor = vec4(mix(1.0, ao, range), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.blurMaterial = new ShaderMaterial({
      uniforms: {
        tAO: { value: null },
        tDepth: { value: null },
        uInvProjection: { value: new Matrix4() },
        uCameraRange: { value: new Vector2(0.1, 1000) },
        uResolution: { value: new Vector2(1, 1) },
        uDirection: { value: new Vector2(1, 0) },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${DEPTH_UTILS}
        uniform sampler2D tAO;
        uniform vec2 uResolution;
        uniform vec2 uDirection;
        varying vec2 vUv;

        void main() {
          float centre = linearDepth(rawDepth(vUv));
          vec2 step = uDirection / uResolution;
          float total = texture2D(tAO, vUv).r;
          float weight = 1.0;
          for (int i = 1; i <= 3; i++) {
            float fi = float(i);
            float w = exp(-fi * fi * 0.28);
            for (int s = -1; s <= 1; s += 2) {
              vec2 uv = vUv + step * fi * float(s);
              float d = linearDepth(rawDepth(uv));
              // Depth-aware: 40 cm of separation halves the contribution.
              float dw = w * exp(-abs(d - centre) * 2.5);
              total += texture2D(tAO, uv).r * dw;
              weight += dw;
            }
          }
          gl_FragColor = vec4(total / weight, 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.quad = new FullScreenQuad(this.aoMaterial);
  }

  setCamera(camera: PerspectiveCamera): void {
    this.camera = camera;
  }

  /** The blurred occlusion buffer, sampled by the composite pass. */
  get texture(): Texture {
    return this.targetA.texture;
  }

  configure(scale: number, samples: number, radius: number, intensity: number): void {
    this.scale = scale;
    this.samples = samples;
    this.aoMaterial.defines.SAMPLES = samples;
    this.aoMaterial.needsUpdate = true;
    this.aoMaterial.uniforms.uRadius.value = radius;
    this.aoMaterial.uniforms.uIntensity.value = intensity;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width * this.scale));
    const h = Math.max(1, Math.floor(height * this.scale));
    this.targetA.setSize(w, h);
    this.targetB.setSize(w, h);
    this.aoMaterial.uniforms.uResolution.value.set(w, h);
    this.blurMaterial.uniforms.uResolution.value.set(w, h);
  }

  override render(renderer: WebGLRenderer, _write: WebGLRenderTarget, _read: WebGLRenderTarget): void {
    const depth = this.depthTexture;
    if (!depth) return;

    this.invProjection.copy(this.camera.projectionMatrixInverse);
    const height = this.targetA.height;
    // Pixels per unit at one metre: half the vertical resolution over tan(fov/2).
    const projScale = height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));

    const ao = this.aoMaterial.uniforms;
    ao.tDepth.value = depth;
    ao.uInvProjection.value.copy(this.invProjection);
    ao.uCameraRange.value.set(this.camera.near, this.camera.far);
    ao.uProjScale.value = projScale;
    ao.uFrame.value = (ao.uFrame.value + 1) % 64;

    this.quad.material = this.aoMaterial;
    renderer.setRenderTarget(this.targetB);
    this.quad.render(renderer);

    const blur = this.blurMaterial.uniforms;
    blur.tDepth.value = depth;
    blur.uInvProjection.value.copy(this.invProjection);
    blur.uCameraRange.value.set(this.camera.near, this.camera.far);
    this.quad.material = this.blurMaterial;

    blur.tAO.value = this.targetB.texture;
    blur.uDirection.value.set(1, 0);
    renderer.setRenderTarget(this.targetA);
    this.quad.render(renderer);

    blur.tAO.value = this.targetA.texture;
    blur.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.targetB);
    this.quad.render(renderer);

    // Leave the finished buffer in targetA so `texture` is stable.
    const swap = this.targetA;
    this.targetA = this.targetB;
    this.targetB = swap;
  }

  /** Set by the engine each frame from the scene pass. */
  depthTexture: Texture | null = null;

  override dispose(): void {
    this.targetA.dispose();
    this.targetB.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.dispose();
  }
}
