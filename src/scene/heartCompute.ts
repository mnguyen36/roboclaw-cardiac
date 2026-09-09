/**
 * Procedural anatomical heart: the heavy, DOM-free computation.
 *
 * The chambers and great vessels are sculpted as a signed distance field so that they
 * blend into each other the way real tissue does, then polygonised with marching cubes.
 * Vertex colours encode myocardium, atria, arterial/venous wall and epicardial fat.
 * Runs inside a Web Worker; the result is plain typed arrays.
 *
 * Units: the field is sculpted in normalised units, exported geometry is in centimetres.
 * Axes: +x = patient's left, +y = superior, +z = anterior.
 */
import { Color } from 'three';
import { SdfModel, ellipsoid, tube, splinePoints, splineRadii, type V3 } from './sdf';
import { sampleField, extractIsosurface, orientToNormals, laplacianSmooth } from './marchingCubes';
import { noise, clamp, smoothstep } from './noise';

export const ANATOMY_VERSION = '2026.09.08-anat2';
export const SCALE = 6.5; // centimetres per model unit

export const Part = {
  LV: 0, RV: 1, RA: 2, LA: 3, AORTA: 4, PA: 5, VCAVA: 6, PVEIN: 7, APPENDAGE: 8, COUNT: 9,
} as const;

export const BASE: V3 = [-0.05, 0.25, -0.05];
export const APEX: V3 = [0.55, -0.85, 0.35];

export function axisDir(): V3 {
  const d: V3 = [APEX[0] - BASE[0], APEX[1] - BASE[1], APEX[2] - BASE[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

function along(t: number): V3 {
  const a = axisDir();
  return [BASE[0] + a[0] * t, BASE[1] + a[1] * t, BASE[2] + a[2] * t];
}

function add(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

/**
 * The atrioventricular ring, in the plane perpendicular to the heart's long axis.
 * `phi` runs from the anterior midline round towards the patient's left.
 */
export function avRing(phi: number, radius = 0.62): V3 {
  const L = axisDir();
  const up: V3 = [0, 1, 0];
  const ux = up[1] * L[2] - up[2] * L[1], uy = up[2] * L[0] - up[0] * L[2], uz = up[0] * L[1] - up[1] * L[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  const u: V3 = [ux / ul, uy / ul, uz / ul];
  const v: V3 = [L[1] * u[2] - L[2] * u[1], L[2] * u[0] - L[0] * u[2], L[0] * u[1] - L[1] * u[0]];
  const c = Math.cos(phi), sn = Math.sin(phi);
  return [
    BASE[0] + (u[0] * c + v[0] * sn) * radius,
    BASE[1] + (u[1] * c + v[1] * sn) * radius,
    BASE[2] + (u[2] * c + v[2] * sn) * radius,
  ];
}

export interface VesselDef {
  id: string;
  label: string;
  control: V3[];
  radii: number[];
  kind: 'artery' | 'vein';
  stenosis?: { t: number; width: number; severity: number };
  /** Fraction of the radius the centreline sits above the surface. */
  embed?: number;
}

export const VESSEL_DEFS: VesselDef[] = [
  {
    id: 'LM', label: 'Left main coronary artery', kind: 'artery',
    control: [[0.04, 0.34, 0.2], [0.11, 0.32, 0.27], [0.16, 0.3, 0.31]],
    radii: [0.03, 0.03, 0.029],
  },
  {
    id: 'LAD', label: 'Left anterior descending artery', kind: 'artery',
    control: [[0.16, 0.3, 0.31], [0.15, 0.19, 0.41], [0.18, 0.04, 0.49], [0.26, -0.26, 0.55], [0.38, -0.56, 0.52], [0.5, -0.8, 0.4], [0.6, -0.93, 0.22]],
    radii: [0.029, 0.027, 0.025, 0.022, 0.019, 0.015, 0.011],
    stenosis: { t: 0.36, width: 0.05, severity: 0.72 },
  },
  {
    id: 'D1', label: 'First diagonal branch', kind: 'artery',
    control: [[0.18, 0.06, 0.48], [0.34, -0.1, 0.45], [0.48, -0.3, 0.38], [0.6, -0.52, 0.28]],
    radii: [0.016, 0.014, 0.011, 0.008],
  },
  {
    // Arises well distal to the planned anastomosis: the heel bite must not sit on a branch ostium.
    id: 'D2', label: 'Second diagonal branch', kind: 'artery',
    control: [[0.345, -0.46, 0.535], [0.48, -0.58, 0.44], [0.58, -0.74, 0.34]],
    radii: [0.012, 0.01, 0.007],
  },
  {
    id: 'LCX', label: 'Left circumflex artery', kind: 'artery',
    control: [[0.16, 0.3, 0.31], [0.3, 0.3, 0.23], [0.46, 0.26, 0.1], [0.58, 0.2, -0.1], [0.6, 0.13, -0.32], [0.5, 0.08, -0.5], [0.36, 0.04, -0.58]],
    radii: [0.026, 0.024, 0.022, 0.02, 0.018, 0.015, 0.012],
  },
  {
    id: 'OM1', label: 'Obtuse marginal branch', kind: 'artery',
    control: [[0.5, 0.24, 0.03], [0.62, 0.0, 0.06], [0.7, -0.28, 0.08], [0.7, -0.55, 0.1]],
    radii: [0.017, 0.014, 0.011, 0.008],
  },
  {
    // Traced along the right atrioventricular groove the model actually carves, so the artery
    // sits in its bed instead of being projected onto whichever structure happens to be
    // nearest. That is what previously draped it over the inferior vena cava.
    id: 'RCA', label: 'Right coronary artery', kind: 'artery',
    control: [
      [-0.12, 0.33, 0.22], [-0.30, 0.28, 0.38], [-0.42, 0.20, 0.42], [-0.49, 0.14, 0.24],
      [-0.58, 0.07, 0.14], [-0.60, 0.00, 0.03], [-0.58, -0.05, -0.09], [-0.53, -0.10, -0.24],
      [-0.46, -0.09, -0.40], [-0.30, -0.02, -0.50], [-0.16, 0.02, -0.52],
    ],
    radii: [0.028, 0.027, 0.026, 0.025, 0.024, 0.023, 0.022, 0.021, 0.020, 0.019, 0.018],
  },
  {
    id: 'PDA', label: 'Posterior descending artery', kind: 'artery',
    control: [[-0.16, 0.02, -0.52], [-0.06, -0.28, -0.52], [0.10, -0.56, -0.42], [0.32, -0.78, -0.18], [0.50, -0.90, 0.04]],
    radii: [0.016, 0.014, 0.012, 0.01, 0.008],
  },
  {
    id: 'AM', label: 'Acute marginal branch', kind: 'artery',
    control: [[-0.60, 0.00, 0.03], [-0.52, -0.24, 0.14], [-0.38, -0.46, 0.24], [-0.18, -0.62, 0.30]],
    radii: [0.014, 0.012, 0.01, 0.007],
  },
  {
    // Runs on the left ventricular side of the anterior interventricular groove, a clear
    // 5-6 mm off the LAD, then turns into the left atrioventricular groove and becomes the
    // coronary sinus. Ordered apex first so the calibre grows towards the sinus.
    id: 'GCV', label: 'Great cardiac vein', kind: 'vein',
    control: [
      [0.60, -0.80, 0.30], [0.50, -0.56, 0.44], [0.40, -0.26, 0.50], [0.33, 0.02, 0.45],
      [0.33, 0.20, 0.34], [0.40, 0.27, 0.16], [0.47, 0.24, -0.01], [0.50, 0.16, -0.15],
    ],
    radii: [0.012, 0.017, 0.021, 0.024, 0.026, 0.028, 0.029, 0.030],
  },
  {
    id: 'CS', label: 'Coronary sinus', kind: 'vein',
    control: [[0.50, 0.16, -0.15], [0.44, 0.06, -0.42], [0.20, -0.02, -0.56], [-0.08, -0.06, -0.58], [-0.32, -0.04, -0.52]],
    radii: [0.03, 0.036, 0.042, 0.048, 0.052],
  },
  {
    id: 'MCV', label: 'Middle cardiac vein', kind: 'vein',
    control: [[-0.32, -0.04, -0.52], [-0.12, -0.32, -0.53], [0.10, -0.60, -0.41], [0.34, -0.80, -0.20]],
    radii: [0.02, 0.018, 0.015, 0.011],
  },
];

/** Raw union of chambers and vessels (no grooves). */
function buildRawSdf(): SdfModel {
  const m = new SdfModel();
  const L = axisDir();

  // Ventricles.
  // A heart is a flattened cone, not a ball: in an adult it runs roughly 12 cm base to apex,
  // 9 cm across and only 6-7 cm front to back. The anteroposterior radii below are therefore
  // deliberately much shorter than the transverse ones, which is what gives the organ its
  // sternocostal flatness and keeps the silhouette conical from every view.
  const lvCenter = along(0.78);
  m.add(ellipsoid({ center: lvCenter, radii: [0.48, 0.66, 0.30], axis: L, part: Part.LV, k: 0.06 }));
  const rvCenter = add(along(0.6), [-0.33, 0.14, 0.16]);
  m.add(ellipsoid({ center: rvCenter, radii: [0.44, 0.58, 0.17], axis: L, part: Part.RV, k: 0.09 }));
  // Right ventricular outflow tract rising to the pulmonary valve
  m.add(tube({
    points: splinePoints([rvCenter, [-0.14, 0.22, 0.31], [0.0, 0.42, 0.30], [0.05, 0.55, 0.29]], 5),
    radius: splineRadii([0.24, 0.20, 0.17, 0.16], 5),
    part: Part.RV, k: 0.1, segmentSmooth: 0.03,
  }));

  // Atria
  m.add(ellipsoid({ center: [-0.52, 0.32, 0.00], radii: [0.28, 0.36, 0.19], rotation: [0.1, 0, -0.15], part: Part.RA, k: 0.10 }));
  m.add(ellipsoid({ center: [-0.30, 0.52, 0.19], radii: [0.19, 0.13, 0.12], rotation: [0.2, -0.4, 0.3], part: Part.APPENDAGE, k: 0.08 }));
  m.add(ellipsoid({ center: [0.05, 0.38, -0.30], radii: [0.42, 0.32, 0.19], rotation: [0.15, 0, 0], part: Part.LA, k: 0.10 }));
  m.add(tube({
    points: splinePoints([[0.36, 0.44, -0.16], [0.47, 0.42, 0.03], [0.45, 0.38, 0.20]], 6),
    radius: splineRadii([0.12, 0.09, 0.055], 6),
    part: Part.APPENDAGE, k: 0.07,
  }));

  // Atrioventricular junction. The sulcus between atria and ventricles is real tissue, and it
  // is what carries the coronary sinus and the right coronary artery round the back of the
  // heart. Without it the crux is a void, and any vessel centreline projected there snaps onto
  // whatever happens to be nearest - which is how the RCA ended up draped over the vena cava.
  {
    const ring: V3[] = [];
    for (let i = 0; i <= 28; i++) ring.push(avRing(Math.PI * (0.18 + (i / 28) * 1.64), 0.46));
    const half = Math.ceil(ring.length / 2);
    m.add(tube({ points: splinePoints(ring.slice(0, half + 1), 3), radius: 0.13, part: Part.LA, k: 0.10, segmentSmooth: 0.04 }));
    m.add(tube({ points: splinePoints(ring.slice(half), 3), radius: 0.13, part: Part.RA, k: 0.10, segmentSmooth: 0.04 }));
  }

  // Aorta: root with sinuses, ascending, arch, descending
  m.add(tube({
    points: splinePoints([
      [-0.05, 0.28, 0.06], [-0.06, 0.42, 0.07], [-0.1, 0.6, 0.1], [-0.16, 0.85, 0.08], [-0.14, 1.05, -0.02],
      [0.0, 1.17, -0.16], [0.18, 1.12, -0.32], [0.27, 0.95, -0.47], [0.29, 0.72, -0.56],
    ], 5),
    radius: splineRadii([0.17, 0.205, 0.165, 0.15, 0.145, 0.14, 0.135, 0.13, 0.125], 5),
    part: Part.AORTA, k: 0.05, segmentSmooth: 0.03,
  }));
  m.add(tube({ points: splinePoints([[-0.1, 1.08, -0.06], [-0.22, 1.3, -0.06], [-0.32, 1.55, -0.04]], 4), radius: splineRadii([0.08, 0.065, 0.06], 4), part: Part.AORTA, k: 0.04 }));
  m.add(tube({ points: splinePoints([[0.02, 1.12, -0.17], [0.02, 1.35, -0.18], [0.0, 1.55, -0.2]], 4), radius: splineRadii([0.06, 0.052, 0.05], 4), part: Part.AORTA, k: 0.04 }));
  m.add(tube({ points: splinePoints([[0.14, 1.1, -0.28], [0.22, 1.3, -0.34], [0.34, 1.55, -0.4]], 4), radius: splineRadii([0.06, 0.052, 0.05], 4), part: Part.AORTA, k: 0.04 }));

  // Pulmonary trunk and branches
  m.add(tube({
    points: splinePoints([[0.05, 0.5, 0.38], [0.1, 0.72, 0.34], [0.16, 0.9, 0.2], [0.2, 1.0, 0.02]], 5),
    radius: splineRadii([0.175, 0.16, 0.15, 0.14], 5),
    part: Part.PA, k: 0.05, segmentSmooth: 0.03,
  }));
  m.add(tube({
    points: splinePoints([[0.2, 1.0, 0.02], [0.0, 0.94, -0.24], [-0.35, 0.9, -0.36], [-0.8, 0.88, -0.4], [-1.3, 0.86, -0.42]], 5),
    radius: splineRadii([0.14, 0.12, 0.11, 0.1, 0.1], 5),
    part: Part.PA, k: 0.04,
  }));
  m.add(tube({
    points: splinePoints([[0.2, 1.0, 0.02], [0.42, 1.0, -0.12], [0.7, 0.96, -0.3], [1.0, 0.92, -0.42], [1.3, 0.9, -0.5]], 5),
    radius: splineRadii([0.14, 0.12, 0.11, 0.1, 0.1], 5),
    part: Part.PA, k: 0.04,
  }));

  // Venae cavae
  m.add(tube({
    points: splinePoints([[-0.6, 1.55, -0.12], [-0.6, 1.0, -0.1], [-0.58, 0.7, -0.06], [-0.56, 0.5, -0.04]], 5),
    radius: splineRadii([0.12, 0.12, 0.12, 0.13], 5),
    part: Part.VCAVA, k: 0.06,
  }));
  m.add(tube({
    points: splinePoints([[-0.64, 0.18, -0.26], [-0.68, -0.06, -0.42], [-0.70, -0.30, -0.56]], 5),
    radius: splineRadii([0.13, 0.13, 0.12], 5),
    part: Part.VCAVA, k: 0.07,
  }));

  // Pulmonary veins (two right, two left)
  const pv = (pts: V3[]) => m.add(tube({ points: splinePoints(pts, 4), radius: splineRadii([0.09, 0.075, 0.07], 4), part: Part.PVEIN, k: 0.06 }));
  pv([[-0.22, 0.50, -0.44], [-0.45, 0.58, -0.56], [-0.64, 0.62, -0.66]]);
  pv([[-0.22, 0.30, -0.48], [-0.45, 0.27, -0.60], [-0.64, 0.22, -0.70]]);
  pv([[0.32, 0.50, -0.46], [0.55, 0.58, -0.60], [0.72, 0.63, -0.70]]);
  pv([[0.32, 0.30, -0.48], [0.55, 0.27, -0.62], [0.72, 0.22, -0.72]]);

  m.clipBox = { min: [-1.25, -1.1, -1.35], max: [1.25, 1.4, 1.05], round: 0.02 };
  return m;
}

export interface HeartSdf {
  sdf: SdfModel;
  grooves: { anteriorIV: V3[]; posteriorIV: V3[]; avArcs: V3[][] };
}

/** Full model: raw union with interventricular and atrioventricular grooves carved in. */
export function buildHeartSdf(): HeartSdf {
  const raw = buildRawSdf();
  const ring: V3[] = [];
  for (let i = 0; i <= 40; i++) ring.push(avRing((i / 40) * Math.PI * 2));
  const anteriorIV = splinePoints([[0.12, 0.33, 0.42], [0.17, 0.05, 0.5], [0.27, -0.3, 0.55], [0.42, -0.62, 0.5], [0.56, -0.86, 0.34]], 6)
    .map((p) => raw.project(p, 0.012));
  const posteriorIV = splinePoints([[-0.12, -0.02, -0.5], [0.02, -0.3, -0.5], [0.22, -0.58, -0.36], [0.45, -0.82, -0.1], [0.56, -0.9, 0.12]], 6)
    .map((p) => raw.project(p, 0.012));
  const avArcs: V3[][] = [];
  let cur: V3[] = [];
  for (const p of ring) {
    const keep = !(p[2] > 0.15 && p[0] > -0.35 && p[0] < 0.3);
    if (keep) cur.push(raw.project(p, 0.012));
    else if (cur.length) { avArcs.push(cur); cur = []; }
  }
  if (cur.length) avArcs.push(cur);

  const cutter = (points: V3[], r: number, k: number) => {
    const t = tube({ points, radius: r, part: 0, segmentSmooth: 0.02 });
    return { k, bounds: t.bounds, dist: t.dist };
  };
  raw.subtract(cutter(anteriorIV, 0.055, 0.08));
  raw.subtract(cutter(posteriorIV, 0.045, 0.07));
  for (const arc of avArcs) if (arc.length > 1) raw.subtract(cutter(arc, 0.035, 0.06));
  return { sdf: raw, grooves: { anteriorIV, posteriorIV, avArcs } };
}

// ---------------------------------------------------------------------------
// Colours (converted to linear space by three's colour management)
// ---------------------------------------------------------------------------
const C = (hex: string) => new Color(hex);
export const PART_COLORS: Color[] = [];
// Sampled against intraoperative photographs of a living heart: the myocardium is a deep
// maroon, far darker and less pink than textbook illustrations, and the anterior surface
// carries much more cream-yellow epicardial fat than diagrams suggest.
PART_COLORS[Part.LV] = C('#6b1d22');
PART_COLORS[Part.RV] = C('#722327');
PART_COLORS[Part.RA] = C('#743843');
PART_COLORS[Part.LA] = C('#6f333e');
PART_COLORS[Part.AORTA] = C('#c9a79c');
PART_COLORS[Part.PA] = C('#b99aa2');
PART_COLORS[Part.VCAVA] = C('#5f4a5c');
PART_COLORS[Part.PVEIN] = C('#6a4655');
PART_COLORS[Part.APPENDAGE] = C('#6d2f39');
export const FAT_A = C('#e6cd85');
export const FAT_B = C('#d0ac53');

/**
 * Ambient occlusion sampled straight from the distance field.
 *
 * Marching outward along the surface normal, the field's own distance tells us how much
 * nearby geometry is crowding the point: in an open area the distance keeps pace with the
 * step, while in a groove or the crease behind a vessel it lags. Accumulating that lag
 * gives the crevice darkening that makes the grooves and coronary beds read as recessed.
 */
function bakeAO(sdf: SdfModel, x: number, y: number, z: number, n: V3): number {
  let occlusion = 0;
  let weight = 1;
  for (let i = 1; i <= 5; i++) {
    const h = 0.01 * i * i;
    const d = sdf.dist(x + n[0] * h, y + n[1] * h, z + n[2] * h);
    occlusion += (h - d) * weight;
    weight *= 0.72;
  }
  return clamp(1 - occlusion * 1.9, 0, 1);
}

export function distToPolyline(path: V3[], x: number, y: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const apx = x - a[0], apy = y - a[1], apz = z - a[2];
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 0 ? (apx * abx + apy * aby + apz * abz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Soft membership of a point in each anatomical part. */
export function makePartWeights(sdf: SdfModel) {
  const partDist = new Float32Array(Part.COUNT);
  const weights = new Float32Array(Part.COUNT);
  return (x: number, y: number, z: number): Float32Array => {
    sdf.partDistances(x, y, z, partDist);
    let sum = 0;
    for (let i = 0; i < Part.COUNT; i++) {
      const d = Math.max(partDist[i], -0.02);
      const w = d > 1e8 ? 0 : Math.exp(-d / 0.045);
      weights[i] = w; sum += w;
    }
    for (let i = 0; i < Part.COUNT; i++) weights[i] /= sum || 1;
    return weights;
  };
}

/** How strongly a point participates in ventricular contraction (0 = static vessel). */
export function beatWeightFor(x: number, y: number, z: number, w: Float32Array): number {
  const L = axisDir();
  const a = (x - BASE[0]) * L[0] + (y - BASE[1]) * L[1] + (z - BASE[2]) * L[2];
  const ventricle = w[Part.LV] + w[Part.RV];
  const atria = w[Part.RA] + w[Part.LA] + w[Part.APPENDAGE];
  const vesselFade = smoothstep(-0.55, 0.05, a);
  return clamp(ventricle * 1.0 + atria * 0.45, 0, 1) * vesselFade;
}

export interface HeartData {
  version: string;
  resolution: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  beatWeights: Float32Array;
  fat: Float32Array;
  /** Baked ambient occlusion, 1 = fully open. */
  ao: Float32Array;
  indices: Uint32Array;
  /** Projected coronary centrelines (model units, flat xyz), keyed by vessel id. */
  vesselPaths: Record<string, number[]>;
  /** Radius (model units) at each centreline point. */
  vesselRadii: Record<string, number[]>;
  triangleCount: number;
  timings: Record<string, number>;
}

export function computeHeartData(resolution: number, onProgress: (label: string, f: number) => void): HeartData {
  const timings: Record<string, number> = {};
  let t0 = performance.now();
  const mark = (k: string) => { const t = performance.now(); timings[k] = Math.round(t - t0); t0 = t; };

  onProgress('Sculpting chambers and great vessels', 0.04);
  const { sdf, grooves } = buildHeartSdf();
  mark('sdf');

  onProgress('Sampling the anatomy field', 0.1);
  const origin: V3 = [-1.3, -1.15, -1.4];
  const cell = 2.6 / (resolution - 1);
  const grid = sampleField((x, y, z) => sdf.dist(x, y, z), resolution, origin, cell, 4);
  mark('sample');

  onProgress('Extracting the epicardial surface', 0.42);
  const iso = extractIsosurface(grid, 0);
  laplacianSmooth(iso, 0.35, 1);
  const vertexCount = iso.positions.length / 3;
  mark('extract');

  onProgress('Projecting coronary vessels', 0.5);
  const vesselPaths: Record<string, number[]> = {};
  const vesselRadii: Record<string, number[]> = {};
  const projected: Record<string, V3[]> = {};
  for (const def of VESSEL_DEFS) {
    const embed = def.embed ?? 0.45;
    // project the control points, then resample densely and project again so the
    // centreline hugs the curved epicardium instead of cutting chords through it
    const ctrl = def.control.map((p, i) => sdf.project(p, def.radii[i] * embed));
    const dense = splinePoints(ctrl, 6);
    const radii = splineRadii(def.radii, 6);
    const pts = dense.map((p, i) => sdf.project(p, radii[i] * embed, 8));
    // light smoothing to remove projection jitter
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < pts.length - 1; i++) {
        for (let a = 0; a < 3; a++) pts[i][a] = pts[i][a] * 0.5 + (pts[i - 1][a] + pts[i + 1][a]) * 0.25;
      }
    }
    projected[def.id] = pts;
    // provisional: re-seated against the finished surface after the relief pass below
    vesselPaths[def.id] = pts.flat();
    vesselRadii[def.id] = radii;
  }
  mark('vessels');

  onProgress('Painting tissue and epicardial fat', 0.56);
  const partWeightsAt = makePartWeights(sdf);
  const fatPaths: { path: V3[]; width: number }[] = [
    { path: grooves.anteriorIV, width: 0.2 }, { path: grooves.posteriorIV, width: 0.16 },
    { path: projected.LCX, width: 0.17 }, { path: projected.RCA, width: 0.2 }, { path: projected.CS, width: 0.12 },
  ];
  const fatAt = (x: number, y: number, z: number, wRV: number, wAtria: number) => {
    let d = Infinity;
    for (const fp of fatPaths) {
      const dd = distToPolyline(fp.path, x, y, z) * (0.2 / fp.width);
      if (dd < d) d = dd;
    }
    const n1 = noise.fbm(x * 3.5 + 3, y * 3.5, z * 3.5, 3);
    let fat = smoothstep(0.26, 0.06, d + n1 * 0.05);
    const n2 = noise.fbm(x * 2.0 + 11, y * 2.0, z * 2.0 + 5, 3);
    // the right ventricle and the atrioventricular groove carry broad sheets of fat
    fat += smoothstep(0.3, 0.62, n2) * wRV * smoothstep(0.05, 0.35, z) * 0.95;
    fat += smoothstep(0.38, 0.68, n2) * wAtria * 0.45;
    return clamp(fat, 0, 1);
  };

  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const beatWeights = new Float32Array(vertexCount);
  const fatMask = new Float32Array(vertexCount);
  const ao = new Float32Array(vertexCount);
  const P = iso.positions;
  const col = new Color();
  const tmp = new Color();
  for (let i = 0; i < vertexCount; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const w = partWeightsAt(x, y, z);
    const wRV = w[Part.RV];
    const wAtria = w[Part.RA] + w[Part.LA] + w[Part.APPENDAGE];
    const fat = fatAt(x, y, z, wRV, wAtria);
    fatMask[i] = fat;
    beatWeights[i] = beatWeightFor(x, y, z, w);
    col.setRGB(0, 0, 0);
    for (let p = 0; p < Part.COUNT; p++) {
      if (w[p] < 1e-3) continue;
      tmp.copy(PART_COLORS[p]).multiplyScalar(w[p]);
      col.add(tmp);
    }
    const mott = noise.fbm(x * 9 + 20, y * 9, z * 9, 3);
    const blotch = noise.fbm(x * 2.5 + 40, y * 2.5, z * 2.5, 2);
    col.multiplyScalar(1 + mott * 0.13 + blotch * 0.08);
    // fine subepicardial veins: thin dark branching lines on the myocardium
    const vn = 1 - Math.abs(noise.noise3(x * 26 + 3, y * 26 + 9, z * 26));
    const vein = Math.pow(Math.max(0, vn - 0.82) / 0.18, 2.2) * (1 - fat) * (w[Part.LV] + w[Part.RV] + wAtria);
    col.multiplyScalar(1 - vein * 0.32);
    // fat: lobulated, with darker creases between lobules
    const fn = noise.fbm(x * 14 + 7, y * 14, z * 14, 2);
    const crease = smoothstep(0.0, 0.12, Math.abs(noise.noise3(x * 20 + 31, y * 20, z * 20 + 17)));
    tmp.copy(FAT_A).lerp(FAT_B, clamp(0.5 + fn * 0.8, 0, 1)).multiplyScalar(0.82 + 0.18 * crease);
    col.lerp(tmp, fat);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  mark('paint');

  onProgress('Adding surface relief', 0.78);
  const eps = 0.006;
  const heightAt = (x: number, y: number, z: number, fat: number) => {
    const amp = 0.0016 + 0.0075 * fat;
    const h = noise.fbm(x * 8, y * 8, z * 8, 3) * amp;
    // lobules: rounded bumps in fat
    const lob = (1 - Math.abs(noise.noise3(x * 20 + 31, y * 20, z * 20 + 17))) * 0.004 * fat;
    const fibre = noise.ridged(x * 28, y * 6, z * 28, 2) * 0.0008 * (1 - fat);
    return h + lob + fibre;
  };
  for (let i = 0; i < vertexCount; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const g = sdf.gradient(x, y, z, 0.005);
    const fat = fatMask[i];
    const h = heightAt(x, y, z, fat);
    const hx = (heightAt(x + eps, y, z, fat) - h) / eps;
    const hy = (heightAt(x, y + eps, z, fat) - h) / eps;
    const hz = (heightAt(x, y, z + eps, fat) - h) / eps;
    const dotg = hx * g[0] + hy * g[1] + hz * g[2];
    let nx = g[0] - (hx - g[0] * dotg) * 0.9;
    let ny = g[1] - (hy - g[1] * dotg) * 0.9;
    let nz = g[2] - (hz - g[2] * dotg) * 0.9;
    const nl = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / nl; normals[i * 3 + 1] = ny / nl; normals[i * 3 + 2] = nz / nl;
    ao[i] = bakeAO(sdf, x, y, z, g);
    P[i * 3] = (x + g[0] * h) * SCALE;
    P[i * 3 + 1] = (y + g[1] * h) * SCALE;
    P[i * 3 + 2] = (z + g[2] * h) * SCALE;
  }
  orientToNormals(iso, normals);
  mark('relief');

  onProgress('Seating the coronary tree', 0.9);
  // The centrelines were projected before being smoothed, and the rendered surface is
  // displaced outward by the relief above. Both leave vessels floating over some segments
  // and buried in others, so every point is re-seated here against the final surface:
  // project onto the isosurface at the intended depth, then follow the same relief the
  // mesh received. This runs last precisely because it depends on the finished surface.
  for (const def of VESSEL_DEFS) {
    const embed = def.embed ?? 0.45;
    const pts = projected[def.id];
    const radii = vesselRadii[def.id];
    for (let i = 0; i < pts.length; i++) {
      const r = radii[Math.min(i, radii.length - 1)];
      const [sx, sy, sz] = sdf.project(pts[i], r * embed, 12);
      const g = sdf.gradient(sx, sy, sz, 0.005);
      const w = partWeightsAt(sx, sy, sz);
      const fat = fatAt(sx, sy, sz, w[Part.RV], w[Part.RA] + w[Part.LA] + w[Part.APPENDAGE]);
      const h = heightAt(sx, sy, sz, fat);
      pts[i] = [sx + g[0] * h, sy + g[1] * h, sz + g[2] * h];
    }
    // a light tangential relaxation, re-seated afterwards so it cannot lift the vessel off
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < pts.length - 1; i++) {
        for (let a = 0; a < 3; a++) pts[i][a] = pts[i][a] * 0.6 + (pts[i - 1][a] + pts[i + 1][a]) * 0.2;
      }
      for (let i = 1; i < pts.length - 1; i++) {
        const r = radii[Math.min(i, radii.length - 1)];
        const [sx, sy, sz] = sdf.project(pts[i], r * embed, 8);
        const g = sdf.gradient(sx, sy, sz, 0.005);
        const w = partWeightsAt(sx, sy, sz);
        const fat = fatAt(sx, sy, sz, w[Part.RV], w[Part.RA] + w[Part.LA] + w[Part.APPENDAGE]);
        const h = heightAt(sx, sy, sz, fat);
        pts[i] = [sx + g[0] * h, sy + g[1] * h, sz + g[2] * h];
      }
    }
    vesselPaths[def.id] = pts.flat();
  }
  mark('seat');

  onProgress('Ready', 1);
  return {
    version: ANATOMY_VERSION,
    resolution,
    positions: iso.positions,
    normals,
    colors,
    beatWeights,
    fat: fatMask,
    ao,
    indices: iso.indices,
    vesselPaths,
    vesselRadii,
    triangleCount: iso.indices.length / 3,
    timings,
  };
}
