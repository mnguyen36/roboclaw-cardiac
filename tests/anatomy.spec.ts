/**
 * Anatomical regression tests.
 *
 * These encode the relationships that a reviewer with an anatomy atlas would check first:
 * vessels must lie in their own grooves, must not pass through each other, and the venous
 * tree must be continuous. Each assertion here corresponds to a defect that was shipped.
 */
import { describe, expect, it } from 'vitest';
import { buildHeartSdf, VESSEL_DEFS, SCALE, makePartWeights, Part, type VesselDef } from '../src/scene/heartCompute';
import { splinePoints, splineRadii, tube, type V3 } from '../src/scene/sdf';

type Traced = { pts: V3[]; radii: number[] };

/** Mirrors the centreline projection in computeHeartData, minus the surface-relief pass. */
function trace(sdf: ReturnType<typeof buildHeartSdf>['sdf'], def: VesselDef): Traced {
  const embed = def.embed ?? 0.45;
  const ctrl = def.control.map((p, i) => sdf.project(p, def.radii[i] * embed));
  const dense = splinePoints(ctrl, 6);
  const radii = splineRadii(def.radii, 6);
  const pts = dense.map((p, i) => sdf.project(p, radii[i] * embed, 8));
  for (let pass = 0; pass < 2; pass++)
    for (let i = 1; i < pts.length - 1; i++)
      for (let a = 0; a < 3; a++) pts[i][a] = pts[i][a] * 0.5 + (pts[i - 1][a] + pts[i + 1][a]) * 0.25;
  return { pts: pts.map((p, i) => sdf.project(p, radii[Math.min(i, radii.length - 1)] * embed, 8)), radii };
}

const mm = (modelUnits: number) => modelUnits * SCALE * 10;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const radiusAt = (v: Traced, i: number) => v.radii[Math.min(i, v.radii.length - 1)];

const { sdf } = buildHeartSdf();
const V: Record<string, Traced> = {};
for (const d of VESSEL_DEFS) V[d.id] = trace(sdf, d);

function nearest(v: Traced, p: V3) {
  let bd = Infinity, bi = 0;
  v.pts.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } });
  return { d: bd, i: bi };
}

describe('coronary and venous tree', () => {
  it('keeps the great cardiac vein clear of the LAD along the whole graft target zone', () => {
    // The two run together in the anterior interventricular groove, but they are separate
    // vessels: an anastomosis planned on the LAD must not land inside the vein.
    for (const f of [0.2, 0.35, 0.5, 0.65]) {
      const i = Math.round(f * (V.LAD.pts.length - 1));
      const g = nearest(V.GCV, V.LAD.pts[i]);
      const clearance = mm(g.d) - mm(radiusAt(V.LAD, i)) - mm(radiusAt(V.GCV, g.i));
      expect(clearance, `LAD/GCV clearance at t=${f}`).toBeGreaterThan(1.5);
    }
  });

  it('joins the great cardiac vein to the coronary sinus', () => {
    expect(mm(dist(V.GCV.pts[V.GCV.pts.length - 1], V.CS.pts[0]))).toBeLessThan(2);
  });

  it('joins the coronary sinus to the middle cardiac vein at the crux', () => {
    expect(mm(dist(V.CS.pts[V.CS.pts.length - 1], V.MCV.pts[0]))).toBeLessThan(4);
  });

  it('continues the right coronary artery into the posterior descending artery', () => {
    expect(mm(dist(V.RCA.pts[V.RCA.pts.length - 1], V.PDA.pts[0]))).toBeLessThan(2);
  });

  it('keeps the right coronary artery outside the inferior vena cava', () => {
    // The RCA runs in the atrioventricular groove. It previously projected onto the caval
    // wall and wrapped around it, because the crux of the heart was an empty region.
    const ivc = tube({
      points: splinePoints([[-0.64, 0.18, -0.26], [-0.68, -0.06, -0.42], [-0.70, -0.30, -0.56]], 5),
      radius: splineRadii([0.13, 0.13, 0.12], 5), part: 0,
    });
    let worst = Infinity;
    V.RCA.pts.forEach((p, i) => { worst = Math.min(worst, mm(ivc.dist(p[0], p[1], p[2]) - radiusAt(V.RCA, i))); });
    expect(worst).toBeGreaterThan(1);
  });

  it('takes the second diagonal off well clear of the planned anastomosis', () => {
    // The anastomosis is centred at t = SITE_T on the LAD and spans 5 mm. A heel bite on a
    // branch ostium is a technical error the geometry should not force.
    const d2 = nearest(V.LAD, V.D2.pts[0]);
    const t = d2.i / (V.LAD.pts.length - 1);
    expect(t).toBeGreaterThan(0.57);
  });

  it('places the lesion beyond the first diagonal', () => {
    const d1 = nearest(V.LAD, V.D1.pts[0]);
    expect(d1.i / (V.LAD.pts.length - 1)).toBeLessThan(0.36);
  });

  it('gives the LAD an adult calibre and length', () => {
    let len = 0;
    for (let i = 1; i < V.LAD.pts.length; i++) len += dist(V.LAD.pts[i], V.LAD.pts[i - 1]);
    expect(len * SCALE).toBeGreaterThan(9);
    expect(len * SCALE).toBeLessThan(13);
    expect(mm(V.LAD.radii[0] * 2)).toBeGreaterThan(3);   // proximal LAD 3-4.5 mm
    expect(mm(V.LAD.radii[0] * 2)).toBeLessThan(4.5);
  });
});

describe('cardiac silhouette', () => {
  it('is flattened front to back rather than spherical', () => {
    const weightsAt = makePartWeights(sdf);
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
    const N = 80;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      const x = -1.2 + (2.4 * i) / (N - 1), y = -1.05 + (1.8 * j) / (N - 1), z = -1.2 + (2.4 * k) / (N - 1);
      if (sdf.dist(x, y, z) > 0) continue;
      const w = weightsAt(x, y, z);
      if (w[Part.LV] + w[Part.RV] + w[Part.RA] + w[Part.LA] + w[Part.APPENDAGE] < 0.6) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const tall = (maxY - minY) * SCALE, wide = (maxX - minX) * SCALE, deep = (maxZ - minZ) * SCALE;
    // An adult heart is roughly 12 x 9 x 6.5 cm. The model is not there yet, but it must at
    // least be clearly deeper-than-wide-than-tall in the right order, not a ball.
    expect(deep).toBeLessThan(wide);
    expect(wide).toBeLessThan(tall);
    expect(deep).toBeLessThan(9);
  });
});
