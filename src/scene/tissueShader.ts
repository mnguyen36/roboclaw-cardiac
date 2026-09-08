/**
 * Surface shading for cardiac tissue.
 *
 * Three additions on top of three.js's physical material, all driven by the quality tier:
 *
 *  - baked ambient occlusion, applied to indirect light so grooves and vessel beds recess;
 *  - a fine detail normal map, projected triplanar because a marching-cubes mesh has no UVs;
 *  - a cheap subsurface term, so thin edge-lit tissue glows red instead of reading as plastic.
 *
 * The detail map is generated procedurally with periodic value noise, so it tiles exactly
 * and costs no download.
 */
import * as THREE from 'three';
import type { BeatUniforms } from './heartbeat';

// ---------------------------------------------------------------------------
// Procedural tiling detail normal map
// ---------------------------------------------------------------------------

/** Integer hash on a wrapped lattice, so the noise repeats exactly every `period`. */
function hash2(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >> 16)) / 4294967296;
}

function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, period, seed);
  const b = hash2(ix + 1, iy, period, seed);
  const c = hash2(ix, iy + 1, period, seed);
  const d = hash2(ix + 1, iy + 1, period, seed);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}

/**
 * Height field for the epicardial surface: broad lobules, finer wrinkles, and a faint
 * directional grain standing in for muscle fibre.
 */
function detailHeight(u: number, v: number, size: number): number {
  let h = 0;
  let amp = 0.5;
  let freq = 4;
  for (let o = 0; o < 5; o++) {
    h += amp * periodicValueNoise(u * freq, v * freq, freq, 1013 + o * 71);
    amp *= 0.5;
    freq *= 2;
  }
  // stretched grain: high frequency across the fibre, low along it
  const grain = periodicValueNoise(u * 48, v * 6, 48, 7717);
  return h + grain * 0.16;
}

/**
 * Builds a tileable tangent-space normal map from the height field above.
 * RGB holds the normal; alpha keeps the height itself, which drives the wetness and
 * micro-occlusion variation that stops the specular reading as one smooth plastic sweep.
 */
export function createDetailNormalTexture(size = 256, strength = 2.2): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = detailHeight(x / size, y / size, size);
      height[y * size + x] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  const span = hi - lo || 1;
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = ((at(x, y) - lo) / span) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // the detail is sampled at a steep grazing angle across a curved surface, so without
  // anisotropic filtering the higher octave collapses to flat grey in the distance
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

export interface TissueUniforms {
  uDetailMap: { value: THREE.Texture | null };
  /** World-space tiling frequency of the detail map. */
  uDetailScale: { value: number };
  uDetailStrength: { value: number };
  /** Subsurface tint and strength for thin, edge-lit tissue. */
  uSubsurfaceColor: { value: THREE.Color };
  uSubsurfaceStrength: { value: number };
  uAoStrength: { value: number };
  /** How much baked AO darkens albedo (crevice shading independent of light direction). */
  uAoAlbedo: { value: number };
  /** Roughness variation from the detail height: wet glints against duller tissue. */
  uWetness: { value: number };
  /** Second, finer detail octave; carries most of the myocardial texture. */
  uFineScale: { value: number };
  uFineStrength: { value: number };
}

export function createTissueUniforms(detailMap: THREE.Texture | null): TissueUniforms {
  return {
    uDetailMap: { value: detailMap },
    uDetailScale: { value: 2.6 },
    uDetailStrength: { value: 1.45 },
    uSubsurfaceColor: { value: new THREE.Color('#c2323a') },
    uSubsurfaceStrength: { value: 0.85 },
    uAoStrength: { value: 1 },
    uAoAlbedo: { value: 0.55 },
    uWetness: { value: 0.42 },
    uFineScale: { value: 4.6 },
    uFineStrength: { value: 1.05 },
  };
}

export interface TissueOptions {
  /** Sample the triplanar detail normal map. */
  detail: boolean;
  /** Apply the subsurface scattering approximation. */
  subsurface: boolean;
  /** The mesh carries an aFat attribute controlling roughness (epicardial fat is duller). */
  fat?: boolean;
}

/**
 * Composes the beat deformation, baked AO, triplanar detail and subsurface terms into one
 * material. Replaces any previous onBeforeCompile on the material.
 */
export function applyTissueShader(
  material: THREE.MeshPhysicalMaterial,
  beat: BeatUniforms,
  tissue: TissueUniforms,
  opts: TissueOptions,
): void {
  const useFat = opts.fat !== false;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, beat, tissue);

    // ---- vertex ----
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aBeatWeight;
attribute float aAO;
${useFat ? 'attribute float aFat;\nvarying float vFat;' : ''}
varying float vAO;
varying vec3 vTriPos;
varying vec3 vTriNormal;
uniform float uBeat;
uniform float uTwist;
uniform vec3 uBase;
uniform vec3 uAxis;
uniform float uAxialScale;
uniform float uRadialScale;
uniform vec3 uStabCenter;
uniform float uStabRadius;
uniform float uStabStrength;

vec3 beatDeform(vec3 p, float weight) {
  vec3 rel = p - uBase;
  float a = dot(rel, uAxis);
  vec3 radial = rel - uAxis * a;
  float w = weight * uBeat;
  float stab = 1.0 - uStabStrength * (1.0 - smoothstep(uStabRadius, uStabRadius * 1.8, distance(p, uStabCenter)));
  w *= stab;
  float axialScale = 1.0 - uAxialScale * w;
  float radialScale = 1.0 - uRadialScale * w;
  float ang = uTwist * w * clamp(a / 8.0, 0.0, 1.0);
  float cs = cos(ang);
  float sn = sin(ang);
  vec3 rot = radial * cs + cross(uAxis, radial) * sn;
  return uBase + uAxis * a * axialScale + rot * radialScale;
}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed = beatDeform(transformed, aBeatWeight);
vAO = aAO;
${useFat ? 'vFat = aFat;' : ''}
vTriPos = transformed;
vTriNormal = normalize(objectNormal);`,
      );

    // ---- fragment ----
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${useFat ? 'varying float vFat;' : ''}
varying float vAO;
varying vec3 vTriPos;
varying vec3 vTriNormal;
uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform vec3 uSubsurfaceColor;
uniform float uSubsurfaceStrength;
uniform float uAoStrength;
uniform float uAoAlbedo;
uniform float uWetness;
uniform float uFineScale;
uniform float uFineStrength;

// Triplanar tangent-space detail, blended by the surface normal. No UVs required.
// Returns the world-space normal offset in xyz and the detail height in w.
vec4 triplanarDetail(vec3 p, vec3 n, float scale) {
  vec3 blend = pow(abs(n), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 1e-4);
  vec4 sx = texture2D(uDetailMap, p.yz * scale);
  vec4 sy = texture2D(uDetailMap, p.xz * scale);
  vec4 sz = texture2D(uDetailMap, p.xy * scale);
  vec3 tx = sx.xyz * 2.0 - 1.0;
  vec3 ty = sy.xyz * 2.0 - 1.0;
  vec3 tz = sz.xyz * 2.0 - 1.0;
  // reorient each projection into world space, then blend
  vec3 dx = vec3(0.0, tx.x, tx.y);
  vec3 dy = vec3(ty.x, 0.0, ty.y);
  vec3 dz = vec3(tz.x, tz.y, 0.0);
  vec3 offset = dx * blend.x + dy * blend.y + dz * blend.z;
  float h = sx.w * blend.x + sy.w * blend.y + sz.w * blend.z;
  return vec4(offset, h);
}`,
      )
      // Sample the detail map once, early, so albedo, roughness and the normal can all use it.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
${opts.detail
  ? `vec4 detailSample = triplanarDetail(vTriPos, vTriNormal, uDetailScale);
// A second, much finer octave. Muscle reads as smooth without it, because the coarse
// octave alone only shapes the lobules of the fat.
vec4 fineSample = triplanarDetail(vTriPos + 17.3, vTriNormal, uFineScale);`
  : 'vec4 detailSample = vec4(0.0, 0.0, 0.0, 0.5);\nvec4 fineSample = vec4(0.0, 0.0, 0.0, 0.5);'}
{
  // Baked occlusion darkens the albedo directly, so grooves stay recessed from every angle.
  diffuseColor.rgb *= mix(1.0, vAO, uAoAlbedo);
${opts.detail ? `
  // Muscle needs its texture in the albedo, not only in the normal: on a smooth, softly
  // lit convex wall a normal perturbation this fine is averaged away by mipmapping, while
  // a matching lightness variation still reads as grain.
  float fatMix = ${useFat ? 'vFat' : '0.0'};
  float coarse = detailSample.w * 0.6 + 0.7;
  float grain = fineSample.w * 0.62 + 0.69;
  diffuseColor.rgb *= mix(1.0, coarse, 0.5);
  diffuseColor.rgb *= mix(1.0, grain, 0.55 * (1.0 - fatMix));` : ''}
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
${opts.detail ? `{
  float fatMix = ${useFat ? 'vFat' : '0.0'};
  // the coarse octave belongs to the fat lobules, the fine one to the muscle
  vec3 detail = detailSample.xyz * uDetailStrength * (1.0 - 0.35 * fatMix)
              + fineSample.xyz * uFineStrength * (1.0 - 0.55 * fatMix);
  normal = normalize(normal + detail);
}` : ''}`,
      );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
${useFat ? 'roughnessFactor = mix(roughnessFactor, 0.62, vFat);' : ''}
${opts.detail ? `
// Wet tissue is not uniformly glossy: the film pools in the hollows and thins over the
// ridges. Varying roughness with the detail height breaks the single plastic highlight.
roughnessFactor = clamp(roughnessFactor + (0.5 - detailSample.w) * uWetness, 0.06, 1.0);` : ''}`,
    );

    // Baked AO on indirect light, plus the subsurface glow.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
{
  float bakedAO = mix(1.0, vAO, uAoStrength);
  reflectedLight.indirectDiffuse *= bakedAO;
  reflectedLight.indirectSpecular *= mix(1.0, bakedAO, 0.75);
}
${opts.subsurface ? `
{
  // Light bleeding through thin tissue: strongest where the surface turns away from the
  // eye, damped inside creases where the AO term says the tissue is thick.
  float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
  reflectedLight.indirectDiffuse += uSubsurfaceColor * diffuseColor.rgb * fres * uSubsurfaceStrength * vAO;
}` : ''}`,
    );
  };
  material.customProgramCacheKey = () => `roboclaw-tissue-${opts.detail ? 1 : 0}${opts.subsurface ? 1 : 0}${useFat ? 1 : 0}`;
  material.needsUpdate = true;
}
