/**
 * Screen-space finishing pass, in the spirit of a ReShade preset.
 *
 * Order matters: bloom reads the linear HDR buffer so only genuinely bright wet highlights
 * bleed, then the grade adds the operating-microscope character (vignette, cool shadows
 * against warm lamp light, a light unsharp mask to recover detail lost to render scaling),
 * and OutputPass performs tone mapping and the sRGB conversion exactly once at the end.
 *
 * three.js applies material tone mapping only when drawing to the default framebuffer, so
 * rendering through a render target and tone mapping in OutputPass does not double up.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Vignette, split-tone grade, saturation and unsharp mask in one pass. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uVignette: { value: 0.28 },
    uSaturation: { value: 1.06 },
    uSharpen: { value: 0.35 },
    uShadowTint: { value: new THREE.Color('#7f95ad') },
    uHighlightTint: { value: new THREE.Color('#fff1de') },
    uTintStrength: { value: 0.12 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uSharpen;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uTintStrength;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // Unsharp mask: restores crispness lost when the render scale drops below 1.
      if (uSharpen > 0.0) {
        vec3 blur =
          texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb +
          texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        c += (c - blur * 0.25) * uSharpen;
      }

      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));

      // Split tone: cool the shadows, warm the lamp-lit highlights.
      vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.0, 0.6, luma));
      c = mix(c, c * tint, uTintStrength);

      c = mix(vec3(luma), c, uSaturation);

      // Vignette, measured from the centre in aspect-corrected space.
      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * dot(d, d) * 2.4;
      c *= clamp(vig, 0.0, 1.0);

      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export interface PostFxOptions {
  bloomStrength?: number;
  bloomRadius?: number;
  /** Only pixels brighter than this bleed, so the effect stays on wet highlights. */
  bloomThreshold?: number;
}

export class PostFx {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private width = 1;
  private height = 1;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: PostFxOptions = {},
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      opts.bloomStrength ?? 0.2,
      opts.bloomRadius ?? 0.45,
      // high threshold so only wet specular highlights bleed, not the pale great vessels
      opts.bloomThreshold ?? 0.92,
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.composer.addPass(new OutputPass());
    this.setSize(size.x, size.y);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer.setSize(this.width, this.height);
    this.bloom.setSize(this.width, this.height);
    (this.grade.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
  }

  /** Keeps the composer matched to the renderer's current drawing buffer. */
  syncSize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.width || size.y !== this.height) this.setSize(size.x, size.y);
  }

  render(): void {
    this.syncSize();
    this.composer.render();
  }

  dispose(): void {
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.bloom.dispose();
    this.grade.dispose();
  }
}
