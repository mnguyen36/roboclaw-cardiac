/**
 * Signed distance field primitives and operators used to sculpt the heart.
 * All functions operate on plain numbers to keep the field sampling loop fast.
 */
import { Matrix4, Quaternion, Vector3, Euler } from 'three';

export type V3 = [number, number, number];

export interface Bounds { min: V3; max: V3 }

export interface Primitive {
  /** Anatomical part id used for material blending. */
  part: number;
  /** Smoothing radius when this primitive is unioned into the model. */
  k: number;
  bounds: Bounds;
  dist(x: number, y: number, z: number): number;
}

/** Polynomial smooth minimum (Inigo Quilez). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth maximum, used for smooth subtraction: smax(d, -cutter, k). */
export function smax(a: number, b: number, k: number): number {
  if (k <= 0) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** Distance from a point to an axis-aligned box (0 inside). */
export function boundsDistance(b: Bounds, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface EllipsoidOpts {
  center: V3;
  radii: V3;
  /** Euler rotation (radians, XYZ order) applied to the ellipsoid. */
  rotation?: V3;
  /** Alternative to rotation: world direction the local +Y radius should point along. */
  axis?: V3;
  /** Extra roll (radians) around `axis`. */
  roll?: number;
  part: number;
  k?: number;
}

/** Oriented ellipsoid with a good distance approximation. */
export function ellipsoid(o: EllipsoidOpts): Primitive {
  const [cx, cy, cz] = o.center;
  const [rx, ry, rz] = o.radii;
  let q: Quaternion;
  if (o.axis) {
    const dir = new Vector3(o.axis[0], o.axis[1], o.axis[2]).normalize();
    q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
    if (o.roll) q.premultiply(new Quaternion().setFromAxisAngle(dir, o.roll));
  } else {
    const rot = o.rotation ?? [0, 0, 0];
    q = new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], 'XYZ'));
  }
  const fwd = new Matrix4().makeRotationFromQuaternion(q);
  const inv = fwd.clone().invert();
  const e = inv.elements; // column-major
  const m00 = e[0], m01 = e[4], m02 = e[8];
  const m10 = e[1], m11 = e[5], m12 = e[9];
  const m20 = e[2], m21 = e[6], m22 = e[10];
  const bmin: V3 = [Infinity, Infinity, Infinity], bmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const v = new Vector3(i & 1 ? rx : -rx, i & 2 ? ry : -ry, i & 4 ? rz : -rz).applyMatrix4(fwd);
    bmin[0] = Math.min(bmin[0], v.x + cx); bmin[1] = Math.min(bmin[1], v.y + cy); bmin[2] = Math.min(bmin[2], v.z + cz);
    bmax[0] = Math.max(bmax[0], v.x + cx); bmax[1] = Math.max(bmax[1], v.y + cy); bmax[2] = Math.max(bmax[2], v.z + cz);
  }
  const irx2 = 1 / (rx * rx), iry2 = 1 / (ry * ry), irz2 = 1 / (rz * rz);
  return {
    part: o.part,
    k: o.k ?? 0.08,
    bounds: { min: bmin, max: bmax },
    dist(x, y, z) {
      const px = x - cx, py = y - cy, pz = z - cz;
      const lx = m00 * px + m01 * py + m02 * pz;
      const ly = m10 * px + m11 * py + m12 * pz;
      const lz = m20 * px + m21 * py + m22 * pz;
      const k0 = Math.sqrt(lx * lx * irx2 + ly * ly * iry2 + lz * lz * irz2);
      const k1 = Math.sqrt(lx * lx * irx2 * irx2 + ly * ly * iry2 * iry2 + lz * lz * irz2 * irz2);
      if (k1 < 1e-9) return -Math.min(rx, ry, rz);
      return (k0 * (k0 - 1)) / k1;
    },
  };
}

/** Exact distance to a tapered capsule (round cone) between a and b with radii r1, r2. */
export function roundConeDist(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r1: number, r2: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

export interface TubeOpts {
  /** Polyline control points (already smoothed/sampled). */
  points: V3[];
  /** Radius per point (same length as points) or a single radius. */
  radius: number[] | number;
  part: number;
  k?: number;
  /** Extra smoothing between consecutive segments. */
  segmentSmooth?: number;
}

/** Tube along a polyline with per-point radius, as a union of round cones. */
export function tube(o: TubeOpts): Primitive {
  const pts = o.points;
  const n = pts.length;
  const radii = typeof o.radius === 'number' ? new Array(n).fill(o.radius) : o.radius;
  const segSmooth = o.segmentSmooth ?? 0.015;
  const bmin: V3 = [Infinity, Infinity, Infinity], bmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = pts[i], r = radii[i];
    for (let a = 0; a < 3; a++) {
      bmin[a] = Math.min(bmin[a], p[a] - r);
      bmax[a] = Math.max(bmax[a], p[a] + r);
    }
  }
  const segBounds: Bounds[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1], r = Math.max(radii[i], radii[i + 1]);
    segBounds.push({
      min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r],
      max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r],
    });
  }
  const flat = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { flat[i * 3] = pts[i][0]; flat[i * 3 + 1] = pts[i][1]; flat[i * 3 + 2] = pts[i][2]; }
  // two-level bounds: chunks of segments, then segments
  const CH = 6;
  const chunkBounds: Bounds[] = [];
  for (let c = 0; c < n - 1; c += CH) {
    const cb: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = c; i < Math.min(n - 1, c + CH); i++) {
      for (let a = 0; a < 3; a++) {
        cb.min[a] = Math.min(cb.min[a], segBounds[i].min[a]);
        cb.max[a] = Math.max(cb.max[a], segBounds[i].max[a]);
      }
    }
    chunkBounds.push(cb);
  }
  return {
    part: o.part,
    k: o.k ?? 0.05,
    bounds: { min: bmin, max: bmax },
    dist(x, y, z) {
      let d = 1e9;
      for (let c = 0, ci = 0; c < n - 1; c += CH, ci++) {
        if (boundsDistance(chunkBounds[ci], x, y, z) >= d + segSmooth) continue;
        const end = Math.min(n - 1, c + CH);
        for (let i = c; i < end; i++) {
          const sb = segBounds[i];
          if (boundsDistance(sb, x, y, z) >= d + segSmooth) continue;
          const di = roundConeDist(
            x, y, z,
            flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2],
            flat[i * 3 + 3], flat[i * 3 + 4], flat[i * 3 + 5],
            radii[i], radii[i + 1],
          );
          d = smin(d, di, segSmooth);
        }
      }
      return d;
    },
  };
}

/** Sample a Catmull-Rom spline through the given points into a denser polyline. */
export function splinePoints(control: V3[], samplesPerSegment = 6, tension = 0.5): V3[] {
  const out: V3[] = [];
  const n = control.length;
  if (n < 2) return control.slice();
  const get = (i: number) => control[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t, t3 = t2 * t;
      const pt: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const v0 = (p2[a] - p0[a]) * tension;
        const v1 = (p3[a] - p1[a]) * tension;
        pt[a] = (2 * p1[a] - 2 * p2[a] + v0 + v1) * t3 + (-3 * p1[a] + 3 * p2[a] - 2 * v0 - v1) * t2 + v0 * t + p1[a];
      }
      out.push(pt);
    }
  }
  out.push(control[n - 1]);
  return out;
}

/** Linearly interpolate radii across the sampled spline. */
export function splineRadii(control: number[], samplesPerSegment = 6): number[] {
  const out: number[] = [];
  for (let i = 0; i < control.length - 1; i++) {
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      out.push(control[i] + (control[i + 1] - control[i]) * t);
    }
  }
  out.push(control[control.length - 1]);
  return out;
}

export interface Subtractor {
  k: number;
  bounds: Bounds;
  dist(x: number, y: number, z: number): number;
}

/**
 * A composed model: smooth union of primitives, then smooth subtraction of cutters,
 * with conservative bounding-box early outs that keep the result exact.
 */
export class SdfModel {
  prims: Primitive[] = [];
  cutters: Subtractor[] = [];
  /** Optional clipping box so vessels leaving the volume end with clean caps. */
  clipBox?: { min: V3; max: V3; round: number };

  add(p: Primitive) { this.prims.push(p); return this; }
  subtract(s: Subtractor) { this.cutters.push(s); return this; }

  dist(x: number, y: number, z: number): number {
    let d = 1e9;
    const prims = this.prims;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      const bd = boundsDistance(p.bounds, x, y, z);
      if (bd >= d + p.k) continue;
      d = smin(d, p.dist(x, y, z), p.k);
    }
    const cutters = this.cutters;
    for (let i = 0; i < cutters.length; i++) {
      const c = cutters[i];
      const bd = boundsDistance(c.bounds, x, y, z);
      if (bd >= c.k - d) continue;
      d = smax(d, -c.dist(x, y, z), c.k);
    }
    if (this.clipBox) {
      const b = this.clipBox;
      const hx = (b.max[0] - b.min[0]) / 2, hy = (b.max[1] - b.min[1]) / 2, hz = (b.max[2] - b.min[2]) / 2;
      const cx = (b.max[0] + b.min[0]) / 2, cy = (b.max[1] + b.min[1]) / 2, cz = (b.max[2] + b.min[2]) / 2;
      const qx = Math.abs(x - cx) - hx + b.round, qy = Math.abs(y - cy) - hy + b.round, qz = Math.abs(z - cz) - hz + b.round;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      const box = Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - b.round;
      d = Math.max(d, box);
    }
    return d;
  }

  /**
   * Per-part distances (min over primitives of each part) used for soft material blending.
   * Primitives farther than `maxDist` (by bounding box) are skipped; their weight is negligible.
   */
  partDistances(x: number, y: number, z: number, out: Float32Array, maxDist = 0.25): void {
    out.fill(1e9);
    const prims = this.prims;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      const bd = boundsDistance(p.bounds, x, y, z);
      if (bd > maxDist || bd >= out[p.part]) continue;
      const d = p.dist(x, y, z);
      if (d < out[p.part]) out[p.part] = d;
    }
  }

  gradient(x: number, y: number, z: number, eps = 0.004): V3 {
    const dx = this.dist(x + eps, y, z) - this.dist(x - eps, y, z);
    const dy = this.dist(x, y + eps, z) - this.dist(x, y - eps, z);
    const dz = this.dist(x, y, z + eps) - this.dist(x, y, z - eps);
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  }

  /** Move a point onto the iso-surface (offset outwards by `offset`). */
  project(p: V3, offset = 0, iterations = 12): V3 {
    let [x, y, z] = p;
    for (let i = 0; i < iterations; i++) {
      const d = this.dist(x, y, z) - offset;
      if (Math.abs(d) < 1e-4) break;
      const g = this.gradient(x, y, z);
      x -= g[0] * d; y -= g[1] * d; z -= g[2] * d;
    }
    return [x, y, z];
  }
}
