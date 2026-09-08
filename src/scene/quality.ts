/**
 * Adaptive quality, the way real-time browser games hold a frame budget.
 *
 * Two mechanisms work together:
 *  - a discrete quality tier that switches expensive shader features and shadows on or off;
 *  - a continuous render scale that resizes the drawing buffer between tier changes.
 *
 * The renderer is almost always fill-rate bound (a few large meshes, few draw calls), so
 * resolution is the strongest and smoothest lever. Tiers only move when resolution alone
 * cannot hold the budget, because switching material features recompiles shaders.
 */
import type { WebGLRenderer } from 'three';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface QualitySettings {
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Re-render the shadow map every N frames (1 = every frame). */
  shadowInterval: number;
  clearcoat: boolean;
  sheen: boolean;
  /** Cool fill and warm rim lights; the key light is always on. */
  extraLights: boolean;
  envIntensity: number;
  /** Triplanar detail normal map on the tissue (three texture fetches). */
  detailNormals: boolean;
  /** Cheap subsurface scattering approximation. */
  subsurface: boolean;
  /** Screen-space post-processing: bloom, vignette, grade. */
  postFx: boolean;
}

export const TIERS: Record<QualityTier, QualitySettings> = {
  ultra: { maxPixelRatio: 2.0, shadows: true, shadowMapSize: 2048, shadowInterval: 1, clearcoat: true, sheen: true, extraLights: true, envIntensity: 0.55, detailNormals: true, subsurface: true, postFx: true },
  high: { maxPixelRatio: 1.5, shadows: true, shadowMapSize: 1024, shadowInterval: 2, clearcoat: true, sheen: true, extraLights: true, envIntensity: 0.55, detailNormals: true, subsurface: true, postFx: true },
  medium: { maxPixelRatio: 1.25, shadows: true, shadowMapSize: 1024, shadowInterval: 4, clearcoat: false, sheen: true, extraLights: true, envIntensity: 0.5, detailNormals: true, subsurface: true, postFx: false },
  low: { maxPixelRatio: 1.0, shadows: false, shadowMapSize: 512, shadowInterval: 0, clearcoat: false, sheen: false, extraLights: false, envIntensity: 0.45, detailNormals: false, subsurface: false, postFx: false },
};

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/** Names reported by CPU rasterisers, which cannot sustain a full-resolution PBR frame. */
const SOFTWARE_RENDERERS = /swiftshader|basic render|llvmpipe|softpipe|microsoft basic|generic renderer|mesa offscreen/i;

export interface GpuInfo {
  renderer: string;
  vendor: string;
  software: boolean;
}

export function detectGpu(renderer: WebGLRenderer): GpuInfo {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? '') : '';
  return { renderer: name, vendor, software: SOFTWARE_RENDERERS.test(name) };
}

/** Starting tier before any measurement, from the GPU name and the display. */
export function initialTier(gpu: GpuInfo): QualityTier {
  if (gpu.software) return 'low';
  if (/intel|uhd graphics|iris|adreno|mali|apple a\d/i.test(gpu.renderer)) return 'medium';
  return 'high';
}

export interface AdaptiveOptions {
  /** Frame budget in milliseconds (16.7 = 60 fps). */
  targetMs?: number;
  minScale?: number;
  maxScale?: number;
  onSettings: (settings: QualitySettings, scale: number, tier: QualityTier) => void;
}

/**
 * Watches frame time and adjusts render scale, then tier, to hold the budget.
 * Uses a median over a window so a single hitch (a shader compile, a GC pause,
 * a step transition) never triggers a quality change.
 */
export class AdaptiveQuality {
  tier: QualityTier;
  scale = 1;
  /** Set false to stop automatic adjustment (manual quality override). */
  auto = true;
  private samples: number[] = [];
  private cooldown = 0;
  private goodStreak = 0;
  private readonly targetMs: number;
  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly onSettings: AdaptiveOptions['onSettings'];

  constructor(tier: QualityTier, opts: AdaptiveOptions) {
    this.tier = tier;
    this.targetMs = opts.targetMs ?? 1000 / 60;
    this.minScale = opts.minScale ?? 0.5;
    this.maxScale = opts.maxScale ?? 1;
    this.onSettings = opts.onSettings;
  }

  get settings(): QualitySettings { return TIERS[this.tier]; }

  /** Apply the current tier and scale immediately. */
  apply(): void { this.onSettings(this.settings, this.scale, this.tier); }

  setTier(tier: QualityTier, auto = false): void {
    this.tier = tier;
    this.auto = auto;
    this.scale = this.maxScale;
    this.samples.length = 0;
    this.cooldown = 45;
    this.apply();
  }

  /** Feed one frame's duration in milliseconds. */
  sample(ms: number): void {
    if (!this.auto) return;
    // ignore absurd frames: tab wake-ups, shader compiles, alt-tab
    if (ms > 500) return;
    this.samples.push(ms);
    if (this.cooldown > 0) { this.cooldown--; if (this.samples.length > 40) this.samples.shift(); return; }
    if (this.samples.length < 40) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.samples.length = 0;

    // Too slow: shed resolution first, then features.
    if (median > this.targetMs * 1.15) {
      this.goodStreak = 0;
      if (this.scale > this.minScale + 1e-3) {
        this.scale = Math.max(this.minScale, this.scale - (median > this.targetMs * 2 ? 0.2 : 0.1));
        this.cooldown = 30;
        this.apply();
      } else {
        const i = ORDER.indexOf(this.tier);
        if (i > 0) {
          this.tier = ORDER[i - 1];
          this.scale = this.maxScale;
          this.cooldown = 60;
          this.apply();
        }
      }
      return;
    }

    // Comfortable headroom: give resolution back, then features.
    if (median < this.targetMs * 0.7) {
      this.goodStreak++;
      if (this.scale < this.maxScale - 1e-3) {
        this.scale = Math.min(this.maxScale, this.scale + 0.1);
        this.cooldown = 30;
        this.apply();
      } else if (this.goodStreak >= 3) {
        const i = ORDER.indexOf(this.tier);
        if (i < ORDER.length - 1) {
          this.tier = ORDER[i + 1];
          this.cooldown = 90;
          this.goodStreak = 0;
          this.apply();
        }
      }
      return;
    }
    this.goodStreak = 0;
  }
}
