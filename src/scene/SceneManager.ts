/**
 * Renderer, camera, lighting rig and frame loop.
 *
 * Lighting mimics an operating theatre: a broad overhead surgical lamp, a cool fill
 * from the anaesthesia side, and a warm rim so wet tissue reads as three-dimensional.
 *
 * Performance: the scene is a handful of large meshes, so frames are fill-rate bound
 * rather than draw-call bound. The drawing buffer is therefore the main lever, driven by
 * AdaptiveQuality. MSAA and preserveDrawingBuffer are both off: each costs more than it
 * gives here, and screenshots re-render synchronously instead.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { AdaptiveQuality, detectGpu, initialTier, type GpuInfo, type QualitySettings, type QualityTier } from './quality';
import { PostFx } from './postfx';

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov?: number;
}

type FrameCallback = (dt: number, elapsed: number) => void;

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly keyLight: THREE.DirectionalLight;
  readonly fillLight: THREE.DirectionalLight;
  readonly rimLight: THREE.DirectionalLight;
  readonly lampTarget = new THREE.Object3D();
  readonly gpu: GpuInfo;
  readonly quality: AdaptiveQuality;
  /** Notified whenever the quality tier or render scale changes. */
  onQualityChange: ((settings: QualitySettings, scale: number, tier: QualityTier) => void) | null = null;
  private callbacks = new Set<FrameCallback>();
  private clock = new THREE.Clock();
  private tween: { from: CameraPose; to: CameraPose; t: number; duration: number; resolve: () => void } | null = null;
  private running = false;
  private frameIndex = 0;
  private labelsActive = false;
  private post: PostFx | null = null;
  private postEnabled = false;
  readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      stencil: false,
      depth: true,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // shadows are driven manually so they can be refreshed at a lower rate than the frame rate
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.classList.add('viewport-canvas');
    container.appendChild(this.renderer.domElement);

    this.gpu = detectGpu(this.renderer);
    this.quality = new AdaptiveQuality(initialTier(this.gpu), {
      targetMs: 1000 / 60,
      onSettings: (s, scale, tier) => this.applyQuality(s, scale, tier),
    });

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.classList.add('viewport-labels');
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
    this.camera.position.set(2, 6, 36);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 90;
    this.controls.target.set(0, 0.5, 0);
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.8;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.keyLight = new THREE.DirectionalLight(0xfff4e6, 2.6);
    this.keyLight.position.set(6, 30, 26);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 5;
    this.keyLight.shadow.camera.far = 90;
    this.keyLight.shadow.camera.left = -16;
    this.keyLight.shadow.camera.right = 16;
    this.keyLight.shadow.camera.top = 16;
    this.keyLight.shadow.camera.bottom = -16;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.05;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    this.scene.add(this.lampTarget);
    this.keyLight.target = this.lampTarget;

    this.fillLight = new THREE.DirectionalLight(0xcfe3f5, 0.7);
    this.fillLight.position.set(-30, 8, 14);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.DirectionalLight(0xffd2b0, 1.1);
    this.rimLight.position.set(8, 14, -30);
    this.scene.add(this.rimLight);

    const hemi = new THREE.HemisphereLight(0x9fb4c2, 0x2a1a1a, 0.35);
    this.scene.add(hemi);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.quality.apply();
    this.resize();
  }

  /** Effective device pixel ratio: display density, capped by tier and scaled adaptively. */
  private effectivePixelRatio(): number {
    const s = this.quality.settings;
    return Math.min(window.devicePixelRatio || 1, s.maxPixelRatio) * this.quality.scale;
  }

  private applyQuality(s: QualitySettings, _scale: number, tier: QualityTier): void {
    this.renderer.shadowMap.enabled = s.shadows;
    if (s.shadows && this.keyLight.shadow.mapSize.width !== s.shadowMapSize) {
      this.keyLight.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.keyLight.castShadow = s.shadows;
    this.fillLight.visible = s.extraLights;
    this.rimLight.visible = s.extraLights;
    this.scene.environmentIntensity = s.envIntensity;
    this.postEnabled = s.postFx;
    if (s.postFx && !this.post) this.post = new PostFx(this.renderer, this.scene, this.camera);
    this.shadowDirty = true;
    this.resize();
    this.onQualityChange?.(s, this.quality.scale, tier);
  }

  private shadowDirty = true;
  /** Ask for a shadow map refresh (after the camera settles or the scene changes). */
  invalidateShadows(): void { this.shadowDirty = true; }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.effectivePixelRatio());
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.labelRenderer.setSize(w, h);
    this.post?.syncSize();
    this.shadowDirty = true;
  }

  /** Screenshots bypass post-processing only when it is off, so what you see is captured. */
  private renderOnce(): void {
    if (this.postEnabled && this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /** CSS2D rendering is skipped entirely while nothing is labelled. */
  setLabelsActive(active: boolean): void {
    if (this.labelsActive === active) return;
    this.labelsActive = active;
    if (!active) this.labelRenderer.domElement.replaceChildren();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    let last = performance.now();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const elapsed = this.clock.elapsedTime;
      this.updateTween(dt);
      this.controls.update();
      for (const cb of this.callbacks) cb(dt, elapsed);

      const s = this.quality.settings;
      if (s.shadows) {
        const due = s.shadowInterval <= 1 || this.frameIndex % s.shadowInterval === 0;
        this.renderer.shadowMap.needsUpdate = due || this.shadowDirty;
        if (this.renderer.shadowMap.needsUpdate) this.shadowDirty = false;
      }
      if (this.postEnabled && this.post) this.post.render();
      else this.renderer.render(this.scene, this.camera);
      if (this.labelsActive) this.labelRenderer.render(this.scene, this.camera);
      this.frameIndex++;

      const now = performance.now();
      this.quality.sample(now - last);
      last = now;
    };
    loop();
  }

  /** Smoothly move the camera to a pose. Resolves when the move completes. */
  flyTo(pose: CameraPose, duration = 1.2): Promise<void> {
    return new Promise((resolve) => {
      if (this.tween) this.tween.resolve();
      this.tween = {
        from: { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov },
        to: { position: pose.position.clone(), target: pose.target.clone(), fov: pose.fov ?? this.camera.fov },
        t: 0,
        duration,
        resolve,
      };
      this.controls.enabled = false;
    });
  }

  private updateTween(dt: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const e = tw.t < 0.5 ? 4 * tw.t * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 3) / 2;
    this.camera.position.lerpVectors(tw.from.position, tw.to.position, e);
    this.controls.target.lerpVectors(tw.from.target, tw.to.target, e);
    const fov = (tw.from.fov ?? 32) + ((tw.to.fov ?? 32) - (tw.from.fov ?? 32)) * e;
    if (Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (tw.t >= 1) {
      this.tween = null;
      this.controls.enabled = true;
      this.shadowDirty = true;
      tw.resolve();
    }
  }

  /** Raycast from a pointer event against the given objects. */
  pick(event: { clientX: number; clientY: number }, objects: THREE.Object3D[], recursive = true): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(objects, recursive);
    return hits.length ? hits[0] : null;
  }

  /** Renders and reads back in the same task, so preserveDrawingBuffer is not needed. */
  screenshot(): string {
    this.renderOnce();
    return this.renderer.domElement.toDataURL('image/png');
  }
}
