/**
 * Assembles the renderable heart from computed anatomy data.
 * Heavy computation runs in a Web Worker (see heart.worker.ts) and is cached in IndexedDB.
 */
import * as THREE from 'three';
import type { V3 } from './sdf';
import { noise, clamp, lerp } from './noise';
import { buildTubeGeometry, bump } from './tubes';
import { applyBeatShader, createBeatUniforms, type BeatUniforms } from './heartbeat';
import { applyTissueShader, createDetailNormalTexture, createTissueUniforms, type TissueUniforms, type TissueOptions } from './tissueShader';
import {
  ANATOMY_VERSION, SCALE, Part, BASE, APEX, axisDir, VESSEL_DEFS, buildHeartSdf,
  makePartWeights, beatWeightFor, computeHeartData, type HeartData, type VesselDef,
} from './heartCompute';
import { loadCachedHeart, storeCachedHeart } from './heartCache';

export { SCALE, Part, VESSEL_DEFS, type VesselDef };

export interface Vessel {
  def: VesselDef;
  /** Centreline in centimetres. */
  curve: THREE.CatmullRomCurve3;
  radiusAt: (t: number) => number;
  mesh: THREE.Mesh;
  length: number;
}

export interface Landmark {
  id: string;
  label: string;
  position: THREE.Vector3;
  kind: 'chamber' | 'vessel' | 'coronary' | 'site';
}

export interface HeartModel {
  group: THREE.Group;
  heart: THREE.Mesh;
  vesselGroup: THREE.Group;
  vessels: Record<string, Vessel>;
  beat: BeatUniforms;
  base: THREE.Vector3;
  axis: THREE.Vector3;
  apex: THREE.Vector3;
  landmarks: Landmark[];
  tissueMaterial: THREE.MeshPhysicalMaterial;
  arteryMaterial: THREE.MeshPhysicalMaterial;
  veinMaterial: THREE.MeshPhysicalMaterial;
  /** Detail, subsurface and AO controls for the tissue shader. */
  tissueUniforms: TissueUniforms;
  /** Exploded-view displacement of the vascular tree, in centimetres. */
  explode: { value: number };
  /** Recompiles the tissue shader with different feature flags (quality tiers). */
  setTissueFeatures(opts: Partial<TissueOptions>): void;
  /** Project a model-unit point onto the epicardium; returns centimetres. */
  surfacePoint(p: V3, offsetCm?: number): THREE.Vector3;
  /** Outward surface normal at a world (cm) position. */
  surfaceNormal(pCm: THREE.Vector3): THREE.Vector3;
  /** Signed distance (cm) from a world position to the epicardium (negative inside). */
  surfaceDistance(pCm: THREE.Vector3): number;
  beatWeightAt(pCm: THREE.Vector3): number;
  triangleCount: number;
  fromCache: boolean;
}

export interface BuildOptions {
  resolution?: number;
  onProgress?: (label: string, fraction: number) => void;
  useCache?: boolean;
}

const C = (hex: string) => new THREE.Color(hex);
// Epicardial coronaries are not the fire-engine red of anatomical diagrams: through the
// adventitia they read as a muted brick-rose with pale connective tissue over them.
const ARTERY = C('#9c4f48');
const ARTERY_DARK = C('#6b2b2a');
const ARTERY_PALE = C('#c69a86');
const PLAQUE = C('#e6dab0');
const VEIN = C('#4a3358');
const VEIN_DARK = C('#2c1d3a');

function computeInWorker(resolution: number, onProgress?: BuildOptions['onProgress']): Promise<HeartData> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./heart.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.(msg.label, msg.fraction);
      else if (msg.type === 'done') { resolve(msg.data as HeartData); worker.terminate(); }
      else if (msg.type === 'error') { reject(new Error(msg.message)); worker.terminate(); }
    };
    worker.onerror = (e) => { reject(new Error(e.message)); worker.terminate(); };
    worker.postMessage({ resolution });
  });
}

export async function buildHeart(opts: BuildOptions = {}): Promise<HeartModel> {
  const resolution = opts.resolution ?? 150;
  const useCache = opts.useCache ?? !import.meta.env.DEV;
  const cacheKey = `${ANATOMY_VERSION}:${resolution}`;
  let data: HeartData | null = null;
  let fromCache = false;
  if (useCache) {
    opts.onProgress?.('Loading anatomy', 0.05);
    data = await loadCachedHeart(cacheKey);
    fromCache = !!data;
  }
  if (!data) {
    try {
      data = await computeInWorker(resolution, opts.onProgress);
    } catch (err) {
      console.warn('[heart] worker unavailable, computing on the main thread', err);
      data = computeHeartData(resolution, (label, f) => opts.onProgress?.(label, f));
    }
    if (useCache) void storeCachedHeart(cacheKey, data);
  }
  opts.onProgress?.('Assembling model', 0.96);
  // yield once so the progress text paints; setTimeout also fires in a background tab,
  // where requestAnimationFrame is throttled and would stall the load
  await new Promise((r) => setTimeout(r, 0));
  const model = assembleHeart(data);
  model.fromCache = fromCache;
  console.info(`[heart] ${data.positions.length / 3} vertices, ${data.triangleCount} triangles ${JSON.stringify(data.timings)} ${fromCache ? '(cached)' : ''}`);
  opts.onProgress?.('Ready', 1);
  return model;
}

export function assembleHeart(data: HeartData): HeartModel {
  const { sdf } = buildHeartSdf();
  const L = axisDir();
  const axis = new THREE.Vector3(L[0], L[1], L[2]);
  const base = new THREE.Vector3(BASE[0], BASE[1], BASE[2]).multiplyScalar(SCALE);
  const beat = createBeatUniforms(base, axis);
  const partWeightsAt = makePartWeights(sdf);

  // Heart surface -----------------------------------------------------------
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
  geometry.setAttribute('aBeatWeight', new THREE.Float32BufferAttribute(data.beatWeights, 1));
  geometry.setAttribute('aFat', new THREE.Float32BufferAttribute(data.fat, 1));
  geometry.setAttribute('aAO', new THREE.Float32BufferAttribute(data.ao ?? new Float32Array(data.positions.length / 3).fill(1), 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  // A thin serous film rather than a varnish: a strong clearcoat reads as polished plastic,
  // so the coat is kept weak and broken up by the detail map's wetness variation.
  const tissueMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
    sheen: 0.35,
    sheenColor: C('#ff9d9d'),
    sheenRoughness: 0.85,
    specularIntensity: 0.55,
    envMapIntensity: 0.85,
  });
  const detailMap = createDetailNormalTexture(256);
  const tissueUniforms = createTissueUniforms(detailMap);
  const tissueOptions: TissueOptions = { detail: true, subsurface: true, fat: true };
  applyTissueShader(tissueMaterial, beat, tissueUniforms, tissueOptions);

  const heart = new THREE.Mesh(geometry, tissueMaterial);
  heart.name = 'heart';
  heart.castShadow = true;
  heart.receiveShadow = true;

  // Coronary tree -----------------------------------------------------------
  const arteryMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.38, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18,
    sheen: 0.25, sheenColor: C('#ff8f8f'), sheenRoughness: 0.9, envMapIntensity: 0.9,
  });
  const veinMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.45, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.25, envMapIntensity: 0.8,
  });
  // Only the vascular tree responds to the exploded view; the myocardium stays put and
  // is ghosted back instead, so the vessels read against their own anatomy.
  const explodeUniform = { value: 0 };
  applyBeatShader(arteryMaterial, beat, { explode: explodeUniform });
  applyBeatShader(veinMaterial, beat, { explode: explodeUniform });

  const vessels: Record<string, Vessel> = {};
  const vesselGroup = new THREE.Group();
  vesselGroup.name = 'vessels';
  const tmp = new THREE.Color();
  for (const def of VESSEL_DEFS) {
    const flat = data.vesselPaths[def.id];
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < flat.length; i += 3) pts.push(new THREE.Vector3(flat[i] * SCALE, flat[i + 1] * SCALE, flat[i + 2] * SCALE));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const radii = data.vesselRadii[def.id];
    const lengths = curve.getLengths(400);
    const total = lengths[lengths.length - 1];
    const ctrlFrac = pts.map((_, i) => lengths[Math.round((i / (pts.length - 1)) * 400)] / total);
    const radiusAt = (t: number) => {
      let r = radii[radii.length - 1];
      for (let i = 0; i < ctrlFrac.length - 1; i++) {
        if (t >= ctrlFrac[i] && t <= ctrlFrac[i + 1]) {
          const f = (t - ctrlFrac[i]) / Math.max(1e-6, ctrlFrac[i + 1] - ctrlFrac[i]);
          r = lerp(radii[i], radii[i + 1], f);
          break;
        }
      }
      if (def.stenosis) r *= 1 - def.stenosis.severity * bump((t - def.stenosis.t) / def.stenosis.width);
      return r * SCALE;
    };
    const isArtery = def.kind === 'artery';
    const baseCol = isArtery ? ARTERY : VEIN;
    const darkCol = isArtery ? ARTERY_DARK : VEIN_DARK;
    const segs = Math.max(24, Math.round(total / 0.1));
    const geo = buildTubeGeometry({
      curve, segments: segs, radial: 16, radius: radiusAt, caps: true,
      color: (t, ang, p) => {
        const n = noise.fbm(p.x * 2.2, p.y * 2.2, p.z * 2.2, 2);
        tmp.copy(baseCol).lerp(darkCol, clamp(0.3 + n * 0.5, 0, 1));
        if (isArtery) {
          // pale adventitia over the vessel, thickest where periarterial fat gathers
          const sheath = noise.fbm(p.x * 5 + 9, p.y * 5, p.z * 5, 2) * 0.5 + 0.5;
          tmp.lerp(ARTERY_PALE, clamp(sheath * 0.4 + Math.cos(ang) * 0.12, 0, 0.55));
        }
        if (def.stenosis) tmp.lerp(PLAQUE, bump((t - def.stenosis.t) / (def.stenosis.width * 1.3)) * 0.9);
        return [tmp.r, tmp.g, tmp.b];
      },
    });
    // Beat weight is taken from the centreline, not from each tube vertex: the vessel is
    // embedded in the epicardium, so the whole ring must move with the surface patch under
    // it. Sampling per vertex gives neighbouring points slightly different weights, which
    // shears the tube and lifts it off the heart as the ventricle contracts.
    const pos = geo.getAttribute('position');
    const uvs = geo.getAttribute('uv');
    const LUT = 128;
    const weightLut = new Float32Array(LUT + 1);
    for (let i = 0; i <= LUT; i++) {
      const c = curve.getPointAt(i / LUT);
      const x = c.x / SCALE, y = c.y / SCALE, z = c.z / SCALE;
      weightLut[i] = beatWeightFor(x, y, z, partWeightsAt(x, y, z));
    }
    const bw = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(uvs.getY(i), 0, 1);
      bw[i] = weightLut[Math.round(t * LUT)];
    }
    geo.setAttribute('aBeatWeight', new THREE.Float32BufferAttribute(bw, 1));
    const mesh = new THREE.Mesh(geo, isArtery ? arteryMaterial : veinMaterial);
    mesh.name = `vessel-${def.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.vessel = def.id;
    vesselGroup.add(mesh);
    vessels[def.id] = { def, curve, radiusAt, mesh, length: total };
  }

  // Helpers and landmarks ---------------------------------------------------
  const surfacePoint = (p: V3, offsetCm = 0) => {
    const q = sdf.project(p, offsetCm / SCALE);
    return new THREE.Vector3(q[0] * SCALE, q[1] * SCALE, q[2] * SCALE);
  };
  const surfaceNormal = (pCm: THREE.Vector3) => {
    const g = sdf.gradient(pCm.x / SCALE, pCm.y / SCALE, pCm.z / SCALE, 0.006);
    return new THREE.Vector3(g[0], g[1], g[2]);
  };
  const surfaceDistance = (pCm: THREE.Vector3) => sdf.dist(pCm.x / SCALE, pCm.y / SCALE, pCm.z / SCALE) * SCALE;
  const lm = (id: string, label: string, kind: Landmark['kind'], p: V3, offset = 0.2): Landmark => ({ id, label, kind, position: surfacePoint(p, offset) });
  const landmarks: Landmark[] = [
    lm('lv', 'Left ventricle', 'chamber', [0.62, -0.45, 0.25]),
    lm('rv', 'Right ventricle', 'chamber', [-0.25, -0.25, 0.55]),
    lm('ra', 'Right atrium', 'chamber', [-0.75, 0.4, 0.15]),
    lm('la', 'Left atrium', 'chamber', [0.1, 0.5, -0.75]),
    lm('laa', 'Left atrial appendage', 'chamber', [0.5, 0.42, 0.2]),
    lm('raa', 'Right atrial appendage', 'chamber', [-0.35, 0.6, 0.4]),
    lm('apex', 'Apex', 'site', [0.58, -0.9, 0.36]),
    lm('aorta', 'Ascending aorta', 'vessel', [-0.2, 0.85, 0.2]),
    lm('arch', 'Aortic arch', 'vessel', [0.05, 1.3, -0.15]),
    lm('pa', 'Pulmonary trunk', 'vessel', [0.2, 0.75, 0.45]),
    lm('svc', 'Superior vena cava', 'vessel', [-0.72, 1.0, -0.05]),
    lm('ivc', 'Inferior vena cava', 'vessel', [-0.72, -0.3, -0.15]),
    lm('pv', 'Pulmonary veins', 'vessel', [0.85, 0.6, -0.75]),
    { id: 'lad', label: 'LAD', kind: 'coronary', position: vessels.LAD.curve.getPointAt(0.55).clone() },
    { id: 'lcx', label: 'Circumflex', kind: 'coronary', position: vessels.LCX.curve.getPointAt(0.5).clone() },
    { id: 'rca', label: 'RCA', kind: 'coronary', position: vessels.RCA.curve.getPointAt(0.45).clone() },
    { id: 'stenosis', label: 'LAD stenosis 72%', kind: 'site', position: vessels.LAD.curve.getPointAt(0.3).clone() },
  ];

  const group = new THREE.Group();
  group.name = 'heart-model';
  group.add(heart);
  group.add(vesselGroup);

  return {
    group, heart, vesselGroup, vessels, beat,
    base, axis, apex: surfacePoint(APEX, 0),
    landmarks, tissueMaterial, arteryMaterial, veinMaterial,
    tissueUniforms,
    explode: explodeUniform,
    setTissueFeatures(opts: Partial<TissueOptions>) {
      const next = { ...tissueOptions, ...opts };
      if (next.detail === tissueOptions.detail && next.subsurface === tissueOptions.subsurface) return;
      tissueOptions.detail = next.detail;
      tissueOptions.subsurface = next.subsurface;
      applyTissueShader(tissueMaterial, beat, tissueUniforms, tissueOptions);
    },
    surfacePoint, surfaceNormal, surfaceDistance,
    beatWeightAt: (pCm) => {
      const x = pCm.x / SCALE, y = pCm.y / SCALE, z = pCm.z / SCALE;
      return beatWeightFor(x, y, z, partWeightsAt(x, y, z));
    },
    triangleCount: data.triangleCount,
    fromCache: false,
  };
}
