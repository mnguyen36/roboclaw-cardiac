/**
 * Surgical overlays: planned paths, targets, incisions, sutures, threads, measurements and labels.
 * Everything lives in world centimetres.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { SceneManager } from './SceneManager';
import type { HeartModel } from './HeartBuilder';
import { applyBeatShader } from './heartbeat';

export const AMBER = 0xe9a23b;
export const PROLENE_BLUE = 0x3d7bd6;
export const PTFE_WHITE = 0xf2efe6;

export class Overlays {
  readonly group = new THREE.Group();
  private lineMaterials = new Set<LineMaterial>();
  private resolution = new THREE.Vector2(1, 1);
  private labels = new Set<CSS2DObject>();
  /** Fired when overlay labels appear or disappear, so CSS2D rendering can be skipped. */
  onLabelsChanged: (() => void) | null = null;

  /** True while any overlay label is present. */
  hasLabels(): boolean { return this.labels.size > 0; }

  constructor(private sm: SceneManager, private heart: HeartModel) {
    this.group.name = 'overlays';
    sm.scene.add(this.group);
    this.resize();
    sm.onFrame(() => this.tick());
  }

  resize(): void {
    const w = this.sm.container.clientWidth || 1, h = this.sm.container.clientHeight || 1;
    this.resolution.set(w, h);
    for (const m of this.lineMaterials) m.resolution.copy(this.resolution);
  }

  private pulseObjects = new Set<THREE.Object3D>();
  private tick(): void {
    const t = performance.now() / 1000;
    for (const o of this.pulseObjects) {
      const s = 1 + 0.18 * Math.sin(t * 5);
      o.scale.setScalar(s);
    }
  }

  /** Makes an overlay mesh follow the heart's contraction. */
  attachBeat(mesh: THREE.Mesh): void {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const w = new Float32Array(pos.count);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      mesh.localToWorld(p);
      w[i] = this.heart.beatWeightAt(p);
    }
    g.setAttribute('aBeatWeight', new THREE.Float32BufferAttribute(w, 1));
    applyBeatShader(mesh.material as THREE.Material, this.heart.beat);
  }

  add<T extends THREE.Object3D>(obj: T): T {
    this.group.add(obj);
    return obj;
  }

  remove(obj: THREE.Object3D | null | undefined): void {
    if (!obj) return;
    this.pulseObjects.delete(obj);
    obj.removeFromParent();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) {
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const mm of mats) { this.lineMaterials.delete(mm as LineMaterial); mm.dispose(); }
      }
      if (o instanceof CSS2DObject) { o.element.remove(); this.labels.delete(o); this.onLabelsChanged?.(); }
    });
  }

  clear(): void {
    for (const c of [...this.group.children]) this.remove(c);
  }

  /** Thick screen-space line through points; dashed by default for planned paths. */
  path(points: THREE.Vector3[], opts: { color?: number; width?: number; dashed?: boolean; opacity?: number; depthTest?: boolean } = {}): Line2 {
    const geo = new LineGeometry();
    geo.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
    const mat = new LineMaterial({
      color: opts.color ?? 0xf6bd63,
      linewidth: opts.width ?? 3,
      dashed: opts.dashed ?? true,
      dashSize: 0.1,
      gapSize: 0.06,
      transparent: true,
      opacity: opts.opacity ?? 0.95,
      depthTest: opts.depthTest ?? true,
      depthWrite: false,
    });
    mat.resolution.copy(this.resolution);
    this.lineMaterials.add(mat);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 5;
    return this.add(line);
  }

  /** Ring target on a surface. */
  marker(position: THREE.Vector3, normal: THREE.Vector3, opts: { radius?: number; color?: number; pulse?: boolean; filled?: boolean; label?: string; cls?: string } = {}): THREE.Group {
    const r = opts.radius ?? 0.12;
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, Math.max(0.012, r * 0.14), 8, 32),
      new THREE.MeshBasicMaterial({ color: opts.color ?? AMBER, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    ring.renderOrder = 6;
    g.add(ring);
    if (opts.filled) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(r * 0.45, 20), new THREE.MeshBasicMaterial({ color: opts.color ?? AMBER, transparent: true, opacity: 0.6, depthWrite: false }));
      dot.renderOrder = 6;
      g.add(dot);
    }
    g.position.copy(position).addScaledVector(normal, 0.02);
    g.lookAt(position.clone().add(normal));
    if (opts.pulse) this.pulseObjects.add(g);
    if (opts.label) g.add(this.makeLabel(opts.label, opts.cls ?? 'k-target'));
    return this.add(g);
  }

  setPulse(obj: THREE.Object3D, on: boolean): void {
    if (on) this.pulseObjects.add(obj); else { this.pulseObjects.delete(obj); obj.scale.setScalar(1); }
  }

  /** Small sphere used for placed points. */
  dot(position: THREE.Vector3, radius = 0.04, color = PROLENE_BLUE): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 }));
    m.position.copy(position);
    return this.add(m);
  }

  /**
   * An incision, built as an open wound rather than a dark line: the two edges part and
   * evert slightly, and the trough between them falls away to dark, wet tissue. The lips
   * carry a paler cut-edge colour, which is what makes a cut read as depth rather than ink.
   */
  cut(points: THREE.Vector3[], normals: THREE.Vector3[], width = 0.05, depth = 0.05): THREE.Mesh {
    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true, roughness: 0.35, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.15,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.woundGeometry(points, normals, width, depth), mat);
    mesh.renderOrder = 4;
    mesh.name = 'incision';
    return this.add(mesh);
  }

  updateCut(mesh: THREE.Mesh, points: THREE.Vector3[], normals: THREE.Vector3[], width = 0.05, depth = 0.05): void {
    mesh.geometry.dispose();
    mesh.geometry = this.woundGeometry(points, normals, width, depth);
  }

  /** Three-rib cross-section swept along the cut: left lip, trough floor, right lip. */
  private woundGeometry(points: THREE.Vector3[], normals: THREE.Vector3[], width: number, depth: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    if (points.length < 2) return g;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    // cut edges are paler where the wall is divided, falling to dark blood in the trough
    const lip = new THREE.Color('#a8595a');
    const mid = new THREE.Color('#611a1f');
    const floor = new THREE.Color('#24060a');
    const tangent = new THREE.Vector3();
    const across = new THREE.Vector3();
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const nrm = normals[Math.min(i, normals.length - 1)];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(n - 1, i + 1)];
      tangent.subVectors(next, prev);
      if (tangent.lengthSq() < 1e-10) tangent.set(1, 0, 0);
      tangent.normalize();
      across.crossVectors(nrm, tangent).normalize();
      // the wound gapes widest in the middle and closes towards each end
      const taper = Math.sin((i / (n - 1)) * Math.PI);
      const w = width * (0.35 + 0.65 * taper);
      const d = depth * (0.3 + 0.7 * taper);
      // left lip, slightly raised; floor; right lip
      const l = p.clone().addScaledVector(across, w).addScaledVector(nrm, 0.008);
      const f = p.clone().addScaledVector(nrm, -d);
      const r = p.clone().addScaledVector(across, -w).addScaledVector(nrm, 0.008);
      const lm = p.clone().addScaledVector(across, w * 0.45).addScaledVector(nrm, -d * 0.45);
      const rm = p.clone().addScaledVector(across, -w * 0.45).addScaledVector(nrm, -d * 0.45);
      for (const [v, c] of [[l, lip], [lm, mid], [f, floor], [rm, mid], [r, lip]] as [THREE.Vector3, THREE.Color][]) {
        pos.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
      }
    }
    const ribs = 5;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < ribs - 1; j++) {
        const a = i * ribs + j, b = a + ribs, c = b + 1, d = a + 1;
        idx.push(a, b, d, b, c, d);
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Thread between two points, arched slightly above the surface along `lift`. */
  thread(a: THREE.Vector3, b: THREE.Vector3, opts: { radius?: number; color?: number; lift?: THREE.Vector3; liftAmount?: number } = {}): THREE.Mesh {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (opts.lift) mid.addScaledVector(opts.lift, opts.liftAmount ?? 0.08);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const geo = new THREE.TubeGeometry(curve, 12, opts.radius ?? 0.012, 6, false);
    const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? PROLENE_BLUE, roughness: 0.35, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    return this.add(mesh);
  }

  /** Straight thread as a cylinder (fast to update). */
  straightThread(a: THREE.Vector3, b: THREE.Vector3, radius = 0.02, color = PTFE_WHITE): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    Overlays.placeCylinder(mesh, a, b, radius);
    return this.add(mesh);
  }

  static placeCylinder(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
    const dir = b.clone().sub(a);
    const len = dir.length();
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.scale.set(radius, Math.max(len, 1e-4), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }

  /** Measurement between two points with a floating label. */
  measurement(a: THREE.Vector3, b: THREE.Vector3, text: string): THREE.Group {
    const g = new THREE.Group();
    const line = new Line2(new LineGeometry().setPositions([a.x, a.y, a.z, b.x, b.y, b.z]), new LineMaterial({ color: 0xffffff, linewidth: 1.5, dashed: false, transparent: true, opacity: 0.9, depthTest: false }));
    (line.material as LineMaterial).resolution.copy(this.resolution);
    this.lineMaterials.add(line.material as LineMaterial);
    line.renderOrder = 8;
    g.add(line);
    for (const p of [a, b]) {
      const tick = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      tick.position.copy(p);
      tick.renderOrder = 8;
      g.add(tick);
    }
    const label = this.makeLabel(text, 'k-target');
    label.position.copy(a).add(b).multiplyScalar(0.5);
    g.add(label);
    return this.add(g);
  }

  makeLabel(text: string, cls = 'k-site'): CSS2DObject {
    const div = document.createElement('div');
    div.className = `lbl ${cls}`;
    div.textContent = text;
    const obj = new CSS2DObject(div);
    obj.center.set(0, 0.5);
    this.labels.add(obj);
    this.onLabelsChanged?.();
    return obj;
  }

  label(position: THREE.Vector3, text: string, cls = 'k-site'): CSS2DObject {
    const l = this.makeLabel(text, cls);
    l.position.copy(position);
    return this.add(l);
  }
}
