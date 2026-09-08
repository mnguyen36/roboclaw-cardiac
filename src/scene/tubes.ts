/**
 * Variable-radius tube geometry along a curve, with optional per-vertex colour and end caps.
 */
import { BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, Vector3 } from 'three';

export interface TubeSpec {
  curve: CatmullRomCurve3;
  segments: number;
  radial: number;
  /** Radius at arc-length parameter t in [0,1]. */
  radius: (t: number) => number;
  /** Optional colour at (t, angle in radians). */
  color?: (t: number, angle: number, point: Vector3) => [number, number, number];
  /** Close the ends with fans. */
  caps?: boolean;
  /** Frame twist offset (radians), useful for aligning the seam. */
  twist?: number;
}

export function buildTubeGeometry(spec: TubeSpec): BufferGeometry {
  const { curve, segments, radial } = spec;
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const P = new Vector3();
  const v = new Vector3();
  const twist = spec.twist ?? 0;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = spec.radius(t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2 + twist;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      v.set(N.x * cs + B.x * sn, N.y * cs + B.y * sn, N.z * cs + B.z * sn);
      positions.push(P.x + v.x * r, P.y + v.y * r, P.z + v.z * r);
      normals.push(v.x, v.y, v.z);
      uvs.push(j / radial, t);
      if (spec.color) {
        const c = spec.color(t, ang, P);
        colors.push(c[0], c[1], c[2]);
      }
    }
  }
  const ring = radial + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ring + j, b = a + ring, c = b + 1, d = a + 1;
      indices.push(a, d, b, b, d, c);
    }
  }
  if (spec.caps) {
    for (const end of [0, 1]) {
      const i = end === 0 ? 0 : segments;
      curve.getPointAt(end, P);
      const tangent = curve.getTangentAt(end);
      const centerIndex = positions.length / 3;
      positions.push(P.x, P.y, P.z);
      const nx = end === 0 ? -tangent.x : tangent.x;
      const ny = end === 0 ? -tangent.y : tangent.y;
      const nz = end === 0 ? -tangent.z : tangent.z;
      normals.push(nx, ny, nz);
      uvs.push(0.5, end);
      if (spec.color) {
        const c = spec.color(end, 0, P);
        colors.push(c[0], c[1], c[2]);
      }
      for (let j = 0; j < radial; j++) {
        const a = i * ring + j, b = i * ring + j + 1;
        if (end === 0) indices.push(centerIndex, a, b);
        else indices.push(centerIndex, b, a);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  if (spec.color) g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  return g;
}

/** Smooth bump in [0,1] centred at 0 with half-width 1. */
export function bump(x: number): number {
  const a = Math.abs(x);
  if (a >= 1) return 0;
  const t = 1 - a;
  return t * t * (3 - 2 * t);
}
