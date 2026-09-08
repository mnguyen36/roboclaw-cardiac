/**
 * Indexed marching cubes over a scalar field (negative = inside).
 * Uses the edge/triangle lookup tables shipped with three.js.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { edgeTable as edgeTableRaw, triTable as triTableRaw } from 'three/examples/jsm/objects/MarchingCubes.js';
import type { V3 } from './sdf';

// The bundled typings mis-declare these tables; they are flat Int32Arrays (256 and 256*16).
const edgeTable = edgeTableRaw as unknown as Int32Array;
const triTable = triTableRaw as unknown as Int32Array;

export interface FieldGrid {
  res: number;           // samples per axis
  origin: V3;            // world position of sample (0,0,0)
  cell: number;          // spacing between samples
  values: Float32Array;  // res^3 values, index = (z*res + y)*res + x
}

export interface IsoMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Samples the field hierarchically: a coarse pass finds the narrow band around the
 * surface, and only cells in that band are sampled at full resolution. Cells far from
 * the surface receive the coarse value (same sign), which is all marching cubes needs.
 */
export function sampleField(
  fn: (x: number, y: number, z: number) => number,
  res: number,
  origin: V3,
  cell: number,
  block = 4,
): FieldGrid {
  const values = new Float32Array(res * res * res);
  const nb = Math.ceil((res - 1) / block) + 1;
  const coarse = new Float32Array(nb * nb * nb);
  const cstep = cell * block;
  let ci = 0;
  for (let k = 0; k < nb; k++) {
    const z = origin[2] + Math.min(k * block, res - 1) * cell;
    for (let j = 0; j < nb; j++) {
      const y = origin[1] + Math.min(j * block, res - 1) * cell;
      for (let i = 0; i < nb; i++) {
        coarse[ci++] = fn(origin[0] + Math.min(i * block, res - 1) * cell, y, z);
      }
    }
  }
  const band = cstep * 1.05; // half diagonal of a coarse block plus margin
  const nb2 = nb * nb;
  for (let k = 0; k < nb - 1; k++) {
    for (let j = 0; j < nb - 1; j++) {
      for (let i = 0; i < nb - 1; i++) {
        let minAbs = Infinity;
        let c = 0;
        for (let dk = 0; dk <= 1; dk++) for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
          const v = coarse[(k + dk) * nb2 + (j + dj) * nb + (i + di)];
          c = v;
          if (Math.abs(v) < minAbs) minAbs = Math.abs(v);
        }
        const i0 = i * block, j0 = j * block, k0 = k * block;
        const i1 = Math.min(i0 + block, res - 1), j1 = Math.min(j0 + block, res - 1), k1 = Math.min(k0 + block, res - 1);
        if (minAbs > band) {
          // far from the surface: fill with a value of the correct sign
          for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) {
            const rowBase = (kk * res + jj) * res;
            for (let ii = i0; ii <= i1; ii++) values[rowBase + ii] = c;
          }
        } else {
          for (let kk = k0; kk <= k1; kk++) {
            const z = origin[2] + kk * cell;
            for (let jj = j0; jj <= j1; jj++) {
              const y = origin[1] + jj * cell;
              const rowBase = (kk * res + jj) * res;
              for (let ii = i0; ii <= i1; ii++) {
                values[rowBase + ii] = fn(origin[0] + ii * cell, y, z);
              }
            }
          }
        }
      }
    }
  }
  return { res, origin, cell, values };
}

/**
 * Extracts the zero iso-surface as an indexed triangle mesh.
 * Vertices on shared edges are welded through a two-slab edge cache.
 */
export function extractIsosurface(grid: FieldGrid, iso = 0): IsoMesh {
  const { res, origin, cell, values } = grid;
  const res2 = res * res;
  const positions: number[] = [];
  const indices: number[] = [];

  let slabA = new Int32Array(res2 * 3).fill(-1);
  let slabB = new Int32Array(res2 * 3).fill(-1);

  const vertOnEdge = (
    slab: Int32Array, i: number, j: number, axis: number,
    x0: number, y0: number, z0: number, v0: number, v1: number,
  ): number => {
    const key = (j * res + i) * 3 + axis;
    let vi = slab[key];
    if (vi >= 0) return vi;
    let t = (iso - v0) / (v1 - v0);
    if (!Number.isFinite(t)) t = 0.5;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x0 + (axis === 0 ? t * cell : 0);
    const py = y0 + (axis === 1 ? t * cell : 0);
    const pz = z0 + (axis === 2 ? t * cell : 0);
    vi = positions.length / 3;
    positions.push(px, py, pz);
    slab[key] = vi;
    return vi;
  };

  const edgeVerts = new Int32Array(12);

  for (let k = 0; k < res - 1; k++) {
    const z0 = origin[2] + k * cell;
    const z1 = z0 + cell;
    for (let j = 0; j < res - 1; j++) {
      const y0 = origin[1] + j * cell;
      const y1 = y0 + cell;
      const row0 = k * res2 + j * res;
      const row1 = row0 + res;
      const row4 = row0 + res2;
      const row5 = row4 + res;
      for (let i = 0; i < res - 1; i++) {
        const c0 = values[row0 + i], c1 = values[row0 + i + 1];
        const c2 = values[row1 + i + 1], c3 = values[row1 + i];
        const c4 = values[row4 + i], c5 = values[row4 + i + 1];
        const c6 = values[row5 + i + 1], c7 = values[row5 + i];
        let cubeIndex = 0;
        if (c0 > iso) cubeIndex |= 1;
        if (c1 > iso) cubeIndex |= 2;
        if (c2 > iso) cubeIndex |= 4;
        if (c3 > iso) cubeIndex |= 8;
        if (c4 > iso) cubeIndex |= 16;
        if (c5 > iso) cubeIndex |= 32;
        if (c6 > iso) cubeIndex |= 64;
        if (c7 > iso) cubeIndex |= 128;
        const bits = edgeTable[cubeIndex];
        if (bits === 0) continue;
        const x0 = origin[0] + i * cell;
        const x1 = x0 + cell;
        if (bits & 1) edgeVerts[0] = vertOnEdge(slabA, i, j, 0, x0, y0, z0, c0, c1);
        if (bits & 2) edgeVerts[1] = vertOnEdge(slabA, i + 1, j, 1, x1, y0, z0, c1, c2);
        if (bits & 4) edgeVerts[2] = vertOnEdge(slabA, i, j + 1, 0, x0, y1, z0, c3, c2);
        if (bits & 8) edgeVerts[3] = vertOnEdge(slabA, i, j, 1, x0, y0, z0, c0, c3);
        if (bits & 16) edgeVerts[4] = vertOnEdge(slabB, i, j, 0, x0, y0, z1, c4, c5);
        if (bits & 32) edgeVerts[5] = vertOnEdge(slabB, i + 1, j, 1, x1, y0, z1, c5, c6);
        if (bits & 64) edgeVerts[6] = vertOnEdge(slabB, i, j + 1, 0, x0, y1, z1, c7, c6);
        if (bits & 128) edgeVerts[7] = vertOnEdge(slabB, i, j, 1, x0, y0, z1, c4, c7);
        if (bits & 256) edgeVerts[8] = vertOnEdge(slabA, i, j, 2, x0, y0, z0, c0, c4);
        if (bits & 512) edgeVerts[9] = vertOnEdge(slabA, i + 1, j, 2, x1, y0, z0, c1, c5);
        if (bits & 1024) edgeVerts[10] = vertOnEdge(slabA, i + 1, j + 1, 2, x1, y1, z0, c2, c6);
        if (bits & 2048) edgeVerts[11] = vertOnEdge(slabA, i, j + 1, 2, x0, y1, z0, c3, c7);
        const base = cubeIndex * 16;
        for (let t = 0; t < 16; t += 3) {
          const e0 = triTable[base + t];
          if (e0 === -1) break;
          const e1 = triTable[base + t + 1];
          const e2 = triTable[base + t + 2];
          const a = edgeVerts[e0], b = edgeVerts[e1], c = edgeVerts[e2];
          if (a === b || b === c || a === c) continue;
          indices.push(a, b, c);
        }
      }
    }
    const tmp = slabA; slabA = slabB; slabB = tmp; slabB.fill(-1);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Make triangle winding consistent with the supplied per-vertex normals. */
export function orientToNormals(mesh: IsoMesh, normals: Float32Array): void {
  const { positions: p, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const dot = nx * (normals[a] + normals[b] + normals[c]) + ny * (normals[a + 1] + normals[b + 1] + normals[c + 1]) + nz * (normals[a + 2] + normals[b + 2] + normals[c + 2]);
    if (dot < 0) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
  }
}

/** One pass of Laplacian smoothing on an indexed mesh (reduces marching cubes slivers). */
export function laplacianSmooth(mesh: IsoMesh, strength = 0.5, passes = 1): void {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const acc = new Float32Array(n * 3);
  const cnt = new Uint16Array(n);
  for (let pass = 0; pass < passes; pass++) {
    acc.fill(0); cnt.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      const pairs = [[a, b], [b, c], [c, a]];
      for (const [u, v] of pairs) {
        acc[u * 3] += positions[v * 3]; acc[u * 3 + 1] += positions[v * 3 + 1]; acc[u * 3 + 2] += positions[v * 3 + 2]; cnt[u]++;
        acc[v * 3] += positions[u * 3]; acc[v * 3 + 1] += positions[u * 3 + 1]; acc[v * 3 + 2] += positions[u * 3 + 2]; cnt[v]++;
      }
    }
    for (let i = 0; i < n; i++) {
      if (cnt[i] === 0) continue;
      const inv = 1 / cnt[i];
      positions[i * 3] += (acc[i * 3] * inv - positions[i * 3]) * strength;
      positions[i * 3 + 1] += (acc[i * 3 + 1] * inv - positions[i * 3 + 1]) * strength;
      positions[i * 3 + 2] += (acc[i * 3 + 2] * inv - positions[i * 3 + 2]) * strength;
    }
  }
}

export function toGeometry(mesh: IsoMesh, normals: Float32Array, colors?: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  if (colors) g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(Array.from(mesh.indices));
  return g;
}
