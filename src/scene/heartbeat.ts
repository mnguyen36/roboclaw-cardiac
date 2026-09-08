/**
 * Cardiac cycle model and the vertex-shader deformation that makes tissue contract.
 * Every material that belongs to the heart shares the same uniform set, so the chambers,
 * coronaries and grafts move together. A "stabilizer" region can locally cancel motion.
 */
import { Material, Vector3 } from 'three';

export interface BeatUniforms {
  uBeat: { value: number };
  uTwist: { value: number };
  uBase: { value: Vector3 };
  uAxis: { value: Vector3 };
  uAxialScale: { value: number };
  uRadialScale: { value: number };
  uStabCenter: { value: Vector3 };
  uStabRadius: { value: number };
  uStabStrength: { value: number };
}

export function createBeatUniforms(base: Vector3, axis: Vector3): BeatUniforms {
  return {
    uBeat: { value: 0 },
    uTwist: { value: 0.16 },
    uBase: { value: base.clone() },
    uAxis: { value: axis.clone().normalize() },
    uAxialScale: { value: 0.11 },
    uRadialScale: { value: 0.075 },
    uStabCenter: { value: new Vector3(0, 0, 0) },
    uStabRadius: { value: 0 },
    uStabStrength: { value: 0 },
  };
}

const VERTEX_HEADER = /* glsl */ `
attribute float aBeatWeight;
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
}
`;

/**
 * Pushes a vertex away from the heart's long axis, used for the exploded view.
 * Radial rather than uniform translation, so the vascular tree opens out like a cage
 * around the heart instead of sliding off to one side.
 */
const EXPLODE_HEADER = /* glsl */ `
uniform float uExplode;

vec3 explodeOut(vec3 p) {
  vec3 rel = p - uBase;
  float a = dot(rel, uAxis);
  vec3 radial = rel - uAxis * a;
  float len = length(radial);
  if (len < 1e-4) return p;
  return p + (radial / len) * uExplode;
}
`;

export interface BeatShaderOptions {
  /** When supplied, the material also responds to the exploded-view control. */
  explode?: { value: number };
}

/** Injects the contraction deformation into any built-in three.js material. */
export function applyBeatShader(material: Material, uniforms: BeatUniforms, opts: BeatShaderOptions = {}): void {
  const explode = opts.explode;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (explode) shader.uniforms.uExplode = explode;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}${explode ? EXPLODE_HEADER : ''}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n transformed = beatDeform(transformed, aBeatWeight);${explode ? '\n transformed = explodeOut(transformed);' : ''}`,
      );
  };
  material.customProgramCacheKey = () => (explode ? 'roboclaw-beat-explode' : 'roboclaw-beat');
  material.needsUpdate = true;
}

/** CPU mirror of `explodeOut`, for placing labels on displaced vessels. */
export function explodePoint(p: Vector3, base: Vector3, axis: Vector3, amount: number): Vector3 {
  const rel = p.clone().sub(base);
  const a = rel.dot(axis);
  const radial = rel.clone().addScaledVector(axis, -a);
  const len = radial.length();
  if (len < 1e-4) return p.clone();
  return p.clone().addScaledVector(radial.divideScalar(len), amount);
}

/**
 * Contraction waveform over a normalised cardiac cycle (0 = R wave).
 * Rapid isovolumic contraction, ejection plateau, then relaxation into diastole.
 */
export function contractionAt(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const rise = smooth(0.03, 0.2, p);
  const fall = 1 - smooth(0.36, 0.58, p);
  return Math.min(rise, fall);
}

/** Synthetic surface ECG (lead II) for one cycle, in millivolts. */
export function ecgAt(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const gauss = (c: number, w: number, a: number) => a * Math.exp(-((p - c) * (p - c)) / (2 * w * w));
  // P wave, Q, R, S, T
  return (
    gauss(0.86, 0.022, 0.15) +   // P (before the R wave of the next cycle)
    gauss(-0.02 + 1, 0.006, -0.1) +
    gauss(0.0, 0.008, 1.2) + gauss(1.0, 0.008, 1.2) +
    gauss(0.018, 0.006, -0.28) +
    gauss(0.28, 0.045, 0.32)
  );
}

/** Arterial blood pressure waveform, mmHg, given systolic/diastolic. */
export function abpAt(phase: number, sys: number, dia: number): number {
  const p = ((phase - 0.08) % 1 + 1) % 1;
  const pulse = p < 0.3 ? Math.sin((p / 0.3) * Math.PI) : 0;
  const notch = p > 0.3 && p < 0.42 ? 0.18 * Math.sin(((p - 0.3) / 0.12) * Math.PI) : 0;
  const decay = p >= 0.3 ? Math.exp(-(p - 0.3) * 2.2) * 0.25 : 0.25;
  const shape = Math.max(pulse, decay) + notch;
  return dia + (sys - dia) * shape;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
