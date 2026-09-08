/**
 * Precision tasks: everything the user (or the robot) does that gets measured.
 *
 *  - IncisionTask: trace a planned cut; measured lateral deviation, length and tremor.
 *  - PointsTask: place sutures on targets in sequence; measured placement error and spacing.
 *  - MeasureTask: caliper measurements between landmarks.
 *  - NeochordTask: attach artificial chordae and set their length.
 *  - ChoiceTask: decision steps with graded options.
 *
 * Control modes: a human hand carries simulated physiological tremor; robot-assisted mode
 * filters tremor and scales hand motion down; the autonomous robot executes the plan itself.
 */
import * as THREE from 'three';
import type { Task, TaskResult, Metric, PointerKind, SurgeryContext } from './types';
import { statusFor, fmt } from './types';
import type { ControlMode } from '../app/state';
import { AMBER, PROLENE_BLUE, PTFE_WHITE } from '../scene/overlays';
import { SCALE, type HeartModel, type Vessel } from '../scene/HeartBuilder';
import { noise } from '../scene/noise';
import { el } from '../ui/layout';

export interface SurfaceHit { point: THREE.Vector3; normal: THREE.Vector3 }
export interface Surface {
  objects: THREE.Object3D[];
  project(p: THREE.Vector3): SurfaceHit;
}

/** Epicardial surface (heart mesh plus coronaries), projection through the distance field. */
export function heartSurface(heart: HeartModel): Surface {
  return {
    objects: [heart.heart, ...Object.values(heart.vessels).map((v) => v.mesh)],
    project(p) {
      const q = heart.surfacePoint([p.x / SCALE, p.y / SCALE, p.z / SCALE], 0);
      return { point: q, normal: heart.surfaceNormal(q) };
    },
  };
}

/** Surface of a coronary tube, projection through its centreline. */
export function vesselSurface(vessel: Vessel, heart: HeartModel): Surface {
  const samples: THREE.Vector3[] = [];
  const N = 400;
  for (let i = 0; i <= N; i++) samples.push(vessel.curve.getPointAt(i / N));
  return {
    objects: [vessel.mesh, heart.heart],
    project(p) {
      let best = 0, bd = Infinity;
      for (let i = 0; i <= N; i++) { const d = samples[i].distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
      const t = best / N;
      const c = vessel.curve.getPointAt(t);
      const tan = vessel.curve.getTangentAt(t);
      const dir = p.clone().sub(c);
      dir.addScaledVector(tan, -dir.dot(tan));
      if (dir.lengthSq() < 1e-8) dir.copy(heart.surfaceNormal(c));
      dir.normalize();
      return { point: c.clone().addScaledVector(dir, vessel.radiusAt(t)), normal: dir };
    },
  };
}

/** Mesh surface: nearest hit is used as is (tremor keeps to the tangent plane). */
export function meshSurface(objects: THREE.Object3D[]): Surface {
  return { objects, project: (p) => ({ point: p.clone(), normal: new THREE.Vector3(0, 1, 0) }) };
}

const TREMOR_AMPLITUDE = 0.042; // cm, peak physiological tremor at the instrument tip

function tangentBasis(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const a = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, a).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return [u, v];
}

/** Simulated hand tremor: 8 to 12 Hz components plus slow drift, in the tangent plane. */
function tremorOffset(t: number, normal: THREE.Vector3, amplitude = TREMOR_AMPLITUDE): THREE.Vector3 {
  const [u, v] = tangentBasis(normal);
  const a = amplitude * (Math.sin(2 * Math.PI * 9.3 * t) + 0.45 * Math.sin(2 * Math.PI * 11.7 * t + 1.3)) * 0.7;
  const b = amplitude * (Math.cos(2 * Math.PI * 10.1 * t + 0.7) + 0.4 * Math.sin(2 * Math.PI * 8.4 * t + 2.1)) * 0.7;
  const drift = 0.03;
  const dx = noise.noise3(t * 0.9, 3.1, 0) * drift;
  const dy = noise.noise3(7.7, t * 0.8, 0) * drift;
  return u.multiplyScalar(a + dx).add(v.multiplyScalar(b + dy));
}

/** Distance from a point to a polyline, plus the arc-length position of the closest point. */
function nearestOnPolyline(p: THREE.Vector3, path: THREE.Vector3[]): { dist: number; s: number } {
  let best = Infinity, bestS = 0, acc = 0;
  const ab = new THREE.Vector3(), ap = new THREE.Vector3();
  for (let i = 0; i < path.length - 1; i++) {
    ab.subVectors(path[i + 1], path[i]);
    ap.subVectors(p, path[i]);
    const l2 = ab.lengthSq();
    const t = l2 > 0 ? THREE.MathUtils.clamp(ap.dot(ab) / l2, 0, 1) : 0;
    const d = ap.addScaledVector(ab, -t).length();
    const len = Math.sqrt(l2);
    if (d < best) { best = d; bestS = acc + t * len; }
    acc += len;
  }
  return { dist: best, s: bestS };
}

function distToPolyline(p: THREE.Vector3, path: THREE.Vector3[]): number {
  return nearestOnPolyline(p, path).dist;
}

function pathLength(path: THREE.Vector3[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += path[i].distanceTo(path[i - 1]);
  return l;
}

/**
 * Score out of 100. Each metric costs nothing up to half its tolerance, a third of its
 * weight at the tolerance, and its full weight at twice the tolerance.
 */
function scoreFrom(parts: { value: number; tol: number; weight: number }[]): number {
  let score = 100;
  for (const p of parts) {
    const f = THREE.MathUtils.clamp((p.value / p.tol - 0.5) / 1.5, 0, 1);
    score -= p.weight * f;
  }
  return Math.max(0, Math.round(score));
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

abstract class BaseTask implements Task {
  abstract title: string;
  abstract instructions: string;
  startLabel = 'Begin';
  robotic = true;
  result: TaskResult | null = null;
  onChange: (() => void) | null = null;
  protected state: 'idle' | 'armed' | 'active' | 'executing' | 'done' = 'idle';
  protected time = 0;
  protected anchor: THREE.Vector3 | null = null;
  protected smoothed: THREE.Vector3 | null = null;
  protected lastHit: SurfaceHit | null = null;
  protected downPos: { x: number; y: number } | null = null;
  protected cancelled = false;

  constructor(protected ctx: SurgeryContext, protected surface: Surface) {}

  get mode(): ControlMode { return this.ctx.store.state.controlMode; }
  get phase(): string { return this.state; }

  abstract mount(): void;
  abstract unmount(): void;
  abstract execute(): Promise<void>;
  abstract pointer(kind: PointerKind, event: PointerEvent): boolean;
  liveMetrics(): Metric[] | null { return null; }

  begin(): void {
    this.state = 'armed';
    this.result = null;
    this.ctx.store.set({ taskActive: true });
    this.onChange?.();
  }

  reset(): void {
    this.cancelled = true;
    this.state = 'idle';
    this.result = null;
    this.anchor = null;
    this.smoothed = null;
    this.ctx.store.set({ taskActive: false });
    this.onChange?.();
  }

  update(dt: number): void { this.time += dt; }

  protected finish(result: TaskResult): void {
    this.result = result;
    this.state = 'done';
    this.ctx.store.set({ taskActive: false });
    this.onChange?.();
  }

  /** Raycast and turn the pointer into an instrument tip position according to the control mode. */
  protected toolPoint(event: PointerEvent): SurfaceHit | null {
    const hit = this.ctx.sm.pick(event, this.surface.objects);
    if (!hit) return null;
    const raw = hit.point.clone();
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : this.surface.project(raw).normal;
    const mode = this.mode;
    let p = raw;
    if (mode === 'assisted') {
      const scale = Math.max(1, this.ctx.store.state.motionScale);
      // scaling and smoothing only apply to continuous motion (a drag), never between separate clicks
      if (this.anchor) {
        p = this.anchor.clone().add(raw.clone().sub(this.anchor).multiplyScalar(1 / scale));
        if (this.ctx.store.state.tremorFilter) {
          if (!this.smoothed) this.smoothed = p.clone();
          this.smoothed.lerp(p, 0.45);
          p = this.smoothed.clone();
        }
      }
      const proj = this.surface.project(p);
      return { point: proj.point, normal: proj.normal.lengthSq() > 0.5 ? proj.normal : normal };
    }
    if (mode === 'manual') {
      p = raw.clone().add(tremorOffset(this.time, normal));
      const proj = this.surface.project(p);
      return { point: proj.point, normal: proj.normal.lengthSq() > 0.5 ? proj.normal : normal };
    }
    return { point: raw, normal };
  }

  protected isClick(event: PointerEvent): boolean {
    if (!this.downPos) return false;
    return Math.hypot(event.clientX - this.downPos.x, event.clientY - this.downPos.y) < 5;
  }
}

// ---------------------------------------------------------------------------
// Incision

export interface IncisionOptions {
  title: string;
  instructions: string;
  plan: THREE.Vector3[];
  normals: THREE.Vector3[];
  toleranceCm: number;
  depthMm?: number;
  lift?: number;
  /** Half-width of the wound gape, in centimetres. */
  cutWidth?: number;
  /** How deep the trough falls below the surface, in centimetres. */
  cutDepth?: number;
  /** Instrument used, which changes the cutting motion. */
  tool?: 'blade' | 'scissors';
  onComplete?: (result: TaskResult) => void;
  /** Called while cutting, with the fraction of plan length covered. */
  onProgress?: (fraction: number) => void;
}

export class IncisionTask extends BaseTask {
  title: string;
  instructions: string;
  startLabel = 'Make the incision';
  private planObj: THREE.Object3D | null = null;
  private startMarker: THREE.Object3D | null = null;
  private endMarker: THREE.Object3D | null = null;
  private cutMesh: THREE.Mesh | null = null;
  private points: THREE.Vector3[] = [];
  private normals: THREE.Vector3[] = [];
  private planLength: number;
  /** Distance travelled along the cut, which drives the biting rhythm of the tool. */
  private cutTravel = 0;

  constructor(ctx: SurgeryContext, surface: Surface, private opts: IncisionOptions) {
    super(ctx, surface);
    this.title = opts.title;
    this.instructions = opts.instructions;
    this.planLength = pathLength(opts.plan);
  }

  mount(): void {
    const { overlays } = this.ctx;
    const lift = this.opts.lift ?? 0.03;
    const lifted = this.opts.plan.map((p, i) => p.clone().addScaledVector(this.opts.normals[i], lift));
    this.planObj = overlays.path(lifted, { dashed: true, width: 2.2 });
    this.startMarker = overlays.marker(this.opts.plan[0], this.opts.normals[0], { radius: 0.1, pulse: true, label: 'Start' });
    this.endMarker = overlays.marker(this.opts.plan[this.opts.plan.length - 1], this.opts.normals[this.opts.normals.length - 1], { radius: 0.08, label: 'End', cls: 'k-site' });
    this.ctx.arms.right.setTool(this.opts.tool ?? 'blade');
    this.ctx.arms.right.show(this.ctx.store.state.layers.instruments);
    this.ctx.arms.right.setTarget(this.opts.plan[0].clone().addScaledVector(this.opts.normals[0], 1.2), this.opts.normals[0]);
  }

  unmount(): void {
    const { overlays } = this.ctx;
    overlays.remove(this.planObj); overlays.remove(this.startMarker); overlays.remove(this.endMarker);
    if (!this.result) overlays.remove(this.cutMesh);
    this.planObj = this.startMarker = this.endMarker = null;
    this.ctx.store.set({ taskActive: false });
  }

  begin(): void {
    super.begin();
    this.clearCut();
    this.ctx.hint(`Press on the <b>Start</b> marker and drag along the dashed line. Release at <b>End</b>. Target length ${fmt.mm(this.planLength, 1)}.`);
  }

  reset(): void {
    super.reset();
    this.clearCut();
    this.ctx.hint(null);
  }

  private clearCut(): void {
    this.ctx.overlays.remove(this.cutMesh);
    this.cutMesh = null;
    this.points = [];
    this.normals = [];
    this.cutTravel = 0;
  }

  pointer(kind: PointerKind, event: PointerEvent): boolean {
    if (this.state === 'armed' && kind === 'down') {
      const hit = this.ctx.sm.pick(event, this.surface.objects);
      if (!hit) return false;
      if (hit.point.distanceTo(this.opts.plan[0]) > 0.6) {
        this.ctx.hint('Start the cut on the <b>Start</b> marker.');
        return false;
      }
      this.anchor = hit.point.clone();
      this.smoothed = null;
      this.time = 0;
      this.state = 'active';
      const tp = this.toolPoint(event);
      if (tp) this.addPoint(tp);
      this.ctx.hint('Cutting. Keep to the dashed line and release at <b>End</b>.');
      return true;
    }
    if (this.state === 'active') {
      if (kind === 'move') {
        const tp = this.toolPoint(event);
        if (tp) this.addPoint(tp);
        return true;
      }
      if (kind === 'up' || kind === 'leave') {
        this.complete(this.mode);
        return false;
      }
      return true;
    }
    return false;
  }

  private addPoint(hit: SurfaceHit): void {
    const last = this.points[this.points.length - 1];
    if (last && last.distanceTo(hit.point) < 0.012) return;
    this.points.push(hit.point.clone());
    this.normals.push(hit.normal.clone());
    const arm = this.ctx.arms.right;
    // press the blade into the tissue rather than gliding over it
    arm.setTarget(hit.point.clone().addScaledVector(hit.normal, -0.02), hit.normal);
    // Cutting motion: the tool bites in a steady rhythm as it advances along the wound,
    // so the incision looks driven by the instrument rather than painted on.
    this.cutTravel += last ? last.distanceTo(hit.point) : 0;
    const bite = 0.5 - 0.5 * Math.cos((this.cutTravel / 0.09) * Math.PI * 2);
    arm.setJaw(arm.kind === 'scissors' ? bite : 0.12 + bite * 0.1);
    if (this.points.length >= 2) {
      const width = this.opts.cutWidth ?? 0.055;
      const depth = this.opts.cutDepth ?? 0.05;
      if (!this.cutMesh) this.cutMesh = this.ctx.overlays.cut(this.points, this.normals, width, depth);
      else this.ctx.overlays.updateCut(this.cutMesh, this.points, this.normals, width, depth);
    }
    this.opts.onProgress?.(Math.min(1, pathLength(this.points) / this.planLength));
  }

  liveMetrics(): Metric[] | null {
    if (this.state !== 'active' && this.state !== 'executing') return null;
    if (this.points.length < 2) return null;
    const m = this.measure();
    return [
      { id: 'dev', label: 'Deviation', value: fmt.mm(m.mean), status: statusFor(m.mean, this.opts.toleranceCm) },
      { id: 'len', label: 'Length', value: fmt.mm(m.length, 1), target: fmt.mm(this.planLength, 1), status: 'neutral' },
      { id: 'tremor', label: 'Tremor', value: fmt.mm(m.tremor), status: statusFor(m.tremor, this.opts.toleranceCm * 0.5) },
    ];
  }

  private measure() {
    const near = this.points.map((p) => nearestOnPolyline(p, this.opts.plan));
    const devs = near.map((n) => n.dist);
    const mean = devs.reduce((a, b) => a + b, 0) / Math.max(1, devs.length);
    const max = devs.reduce((a, b) => Math.max(a, b), 0);
    // tremor: residual after a moving average of the lateral deviation
    let tremorSum = 0, n = 0;
    for (let i = 2; i < devs.length - 2; i++) {
      const avg = (devs[i - 2] + devs[i - 1] + devs[i] + devs[i + 1] + devs[i + 2]) / 5;
      tremorSum += (devs[i] - avg) ** 2; n++;
    }
    const tremor = n ? Math.sqrt(tremorSum / n) : 0;
    // effective length: extent covered along the planned line (jitter does not count as length)
    let sMin = Infinity, sMax = -Infinity;
    for (const q of near) { if (q.s < sMin) sMin = q.s; if (q.s > sMax) sMax = q.s; }
    const overshoot = this.points.length ? Math.max(0, this.points[this.points.length - 1].distanceTo(this.opts.plan[this.opts.plan.length - 1]) - devs[devs.length - 1]) : 0;
    const length = near.length ? sMax - sMin + overshoot : 0;
    const endErr = this.points.length ? this.points[this.points.length - 1].distanceTo(this.opts.plan[this.opts.plan.length - 1]) : this.planLength;
    return { mean, max, tremor, length, endErr };
  }

  private complete(mode: ControlMode): void {
    if (this.points.length < 3) {
      this.state = 'armed';
      this.clearCut();
      this.ctx.hint('The cut was too short. Press on <b>Start</b> and drag along the line.');
      return;
    }
    const m = this.measure();
    const tol = this.opts.toleranceCm;
    const lenErr = Math.abs(m.length - this.planLength);
    const coverage = Math.min(1, m.length / this.planLength);
    const score = scoreFrom([
      { value: m.mean, tol, weight: 40 },
      { value: m.max, tol: tol * 2.2, weight: 15 },
      { value: lenErr, tol: Math.max(tol * 2, this.planLength * 0.1), weight: 20 },
      { value: m.endErr, tol: tol * 2.5, weight: 10 },
      { value: m.tremor, tol: tol * 0.6, weight: 15 },
    ]) * (coverage < 0.6 ? 0.5 : 1);
    const metrics: Metric[] = [
      { id: 'mean', label: 'Mean deviation from plan', value: fmt.mm(m.mean), target: `≤ ${fmt.mm(tol, 1)}`, status: statusFor(m.mean, tol) },
      { id: 'max', label: 'Maximum deviation', value: fmt.mm(m.max), target: `≤ ${fmt.mm(tol * 2, 1)}`, status: statusFor(m.max, tol * 2) },
      { id: 'length', label: 'Incision length', value: fmt.mm(m.length, 1), target: fmt.mm(this.planLength, 1), status: statusFor(lenErr, Math.max(tol * 2, this.planLength * 0.1)) },
      { id: 'end', label: 'Endpoint error', value: fmt.mm(m.endErr), target: `≤ ${fmt.mm(tol * 2.5, 1)}`, status: statusFor(m.endErr, tol * 2.5) },
      { id: 'tremor', label: 'Tremor (high-frequency residual)', value: fmt.mm(m.tremor), target: `≤ ${fmt.mm(tol * 0.6, 2)}`, status: statusFor(m.tremor, tol * 0.6) },
    ];
    this.ctx.hint(null);
    this.finish({
      score: Math.round(score), metrics, mode,
      summary: `${this.title}: mean deviation ${fmt.mm(m.mean)} over ${fmt.mm(m.length, 1)}`,
      raw: { meanDeviationMm: m.mean * 10, maxDeviationMm: m.max * 10, lengthMm: m.length * 10, tremorMm: m.tremor * 10 },
    });
    this.opts.onComplete?.(this.result!);
  }

  async execute(): Promise<void> {
    this.begin();
    this.state = 'executing';
    this.cancelled = false;
    this.clearCut();
    this.ctx.hint('Autonomous execution: the robot follows the planned incision.');
    const plan = this.opts.plan;
    const total = this.planLength;
    const speed = 0.22; // cm per second
    let s = 0;
    const arm = this.ctx.arms.right;
    // approach
    arm.setTarget(plan[0].clone().addScaledVector(this.opts.normals[0], 0.3), this.opts.normals[0]);
    await wait(500);
    while (s <= total && !this.cancelled) {
      const p = samplePath(plan, s);
      const n = this.surface.project(p).normal;
      const [u, v] = tangentBasis(n);
      const jitter = u.multiplyScalar((Math.random() - 0.5) * 0.006).add(v.multiplyScalar((Math.random() - 0.5) * 0.006));
      const proj = this.surface.project(p.clone().add(jitter));
      this.addPoint({ point: proj.point, normal: proj.normal });
      s += speed / 60;
      await wait(1000 / 60);
    }
    if (this.cancelled) return;
    const endProj = this.surface.project(plan[plan.length - 1]);
    this.addPoint(endProj);
    this.complete('autonomous');
  }
}

function samplePath(path: THREE.Vector3[], s: number): THREE.Vector3 {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = path[i].distanceTo(path[i - 1]);
    if (acc + seg >= s) return path[i - 1].clone().lerp(path[i], seg > 0 ? (s - acc) / seg : 0);
    acc += seg;
  }
  return path[path.length - 1].clone();
}

// ---------------------------------------------------------------------------
// Points (sutures, neochord attachment, site selection)

export interface PointTarget { position: THREE.Vector3; normal: THREE.Vector3; label?: string }
export interface PointsOptions {
  title: string;
  instructions: string;
  targets: PointTarget[];
  toleranceCm: number;
  thread?: 'prolene' | 'ptfe' | 'none';
  /** Draw a knot dot at each bite. */
  knots?: boolean;
  markerRadius?: number;
  startLabel?: string;
  onPlace?: (index: number, point: THREE.Vector3, error: number) => void;
  onComplete?: (result: TaskResult) => void;
  /** If true, only score placement (no spacing metric). */
  single?: boolean;
  liftAmount?: number;
}

export class PointsTask extends BaseTask {
  title: string;
  instructions: string;
  private markers: THREE.Object3D[] = [];
  private placed: { point: THREE.Vector3; error: number }[] = [];
  private objects: THREE.Object3D[] = [];
  private index = 0;

  constructor(ctx: SurgeryContext, surface: Surface, private opts: PointsOptions) {
    super(ctx, surface);
    this.title = opts.title;
    this.instructions = opts.instructions;
    if (opts.startLabel) this.startLabel = opts.startLabel;
  }

  mount(): void {
    const r = this.opts.markerRadius ?? 0.09;
    this.markers = this.opts.targets.map((t, i) => this.ctx.overlays.marker(t.position, t.normal, { radius: r, color: i === 0 ? AMBER : 0x9fb0b6, label: t.label, cls: 'k-target' }));
    this.ctx.overlays.setPulse(this.markers[0], true);
    this.ctx.arms.right.setTool(this.opts.thread === 'none' ? 'hook' : 'needle');
    this.ctx.arms.right.show(this.ctx.store.state.layers.instruments);
    const t0 = this.opts.targets[0];
    this.ctx.arms.right.setTarget(t0.position.clone().addScaledVector(t0.normal, 1.0), t0.normal);
  }

  unmount(): void {
    for (const m of this.markers) this.ctx.overlays.remove(m);
    this.markers = [];
    if (!this.result) this.clearPlaced();
    this.ctx.store.set({ taskActive: false });
  }

  begin(): void {
    super.begin();
    this.clearPlaced();
    this.setCurrent(0);
    this.ctx.hint(`Click on each highlighted target in order. ${this.opts.targets.length} ${this.opts.targets.length === 1 ? 'point' : 'points'} to place. Tolerance ${fmt.mm(this.opts.toleranceCm, 1)}.`);
  }

  reset(): void {
    super.reset();
    this.clearPlaced();
    this.setCurrent(0);
    this.ctx.hint(null);
  }

  private clearPlaced(): void {
    for (const o of this.objects) this.ctx.overlays.remove(o);
    this.objects = [];
    this.placed = [];
    this.index = 0;
  }

  private setCurrent(i: number): void {
    this.index = i;
    this.markers.forEach((m, k) => {
      const ring = m.children[0] as THREE.Mesh;
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.color.set(k < i ? 0x4fd18b : k === i ? AMBER : 0x9fb0b6);
      this.ctx.overlays.setPulse(m, k === i && this.state !== 'done' && this.state !== 'idle');
    });
  }

  pointer(kind: PointerKind, event: PointerEvent): boolean {
    if (this.state !== 'armed') return false;
    if (kind === 'down') { this.downPos = { x: event.clientX, y: event.clientY }; this.anchor = null; return false; }
    if (kind === 'move') {
      const tp = this.toolPoint(event);
      if (tp) this.ctx.arms.right.setTarget(tp.point, tp.normal);
      return false;
    }
    if (kind === 'up' && this.isClick(event)) {
      this.time += 0.37; // decorrelate tremor between clicks
      const tp = this.toolPoint(event);
      if (!tp) return false;
      this.place(tp.point, this.mode);
    }
    return false;
  }

  private place(point: THREE.Vector3, mode: ControlMode): void {
    const target = this.opts.targets[this.index];
    if (!target) return;
    if (point.distanceTo(target.position) > Math.max(1.2, this.opts.toleranceCm * 8)) {
      this.ctx.hint('That is far from the highlighted target. Place the point on the amber ring.');
      return;
    }
    const error = point.distanceTo(target.position);
    this.placed.push({ point: point.clone(), error });
    const { overlays } = this.ctx;
    const thread = this.opts.thread ?? 'prolene';
    const color = thread === 'ptfe' ? PTFE_WHITE : PROLENE_BLUE;
    if (this.opts.knots !== false && thread !== 'none') this.objects.push(overlays.dot(point, 0.04, color));
    if (thread !== 'none' && this.placed.length >= 2) {
      const prev = this.placed[this.placed.length - 2].point;
      this.objects.push(overlays.thread(prev, point, { color, lift: target.normal, liftAmount: this.opts.liftAmount ?? 0.12, radius: 0.018 }));
    }
    if (thread === 'none') this.objects.push(overlays.marker(point, target.normal, { radius: 0.05, color: 0x4fd18b, filled: true }));
    void this.animateBite(point, target.normal);
    this.opts.onPlace?.(this.index, point, error);
    if (this.index + 1 >= this.opts.targets.length) {
      this.setCurrent(this.index + 1);
      this.complete(mode);
    } else {
      this.setCurrent(this.index + 1);
      const next = this.opts.targets[this.index];
      this.ctx.arms.right.setTarget(next.position.clone().addScaledVector(next.normal, 0.5), next.normal);
    }
    this.onChange?.();
  }

  /**
   * One suture bite: the jaws open, the wrist drives the curved needle through the tissue
   * by rolling about the tool axis, the jaws close on the far side, and the needle lifts.
   * Runs alongside the task rather than blocking it, so placement stays responsive.
   */
  private async animateBite(point: THREE.Vector3, normal: THREE.Vector3): Promise<void> {
    const arm = this.ctx.arms.right;
    if (arm.kind !== 'needle') return;
    arm.setJaw(1);
    arm.setTarget(point.clone().addScaledVector(normal, 0.22), normal);
    await wait(80);
    arm.setTarget(point.clone().addScaledVector(normal, -0.025), normal);
    arm.setRoll(1.0);
    await wait(150);
    arm.setJaw(0);
    await wait(90);
    arm.setTarget(point.clone().addScaledVector(normal, 0.3), normal);
    arm.setRoll(0);
    await wait(120);
    arm.setJaw(0.35);
  }

  liveMetrics(): Metric[] | null {
    if (this.state !== 'armed' && this.state !== 'executing') return null;
    const n = this.placed.length;
    const mean = n ? this.placed.reduce((a, b) => a + b.error, 0) / n : 0;
    return [
      { id: 'count', label: 'Placed', value: `${n} / ${this.opts.targets.length}`, status: 'neutral' },
      { id: 'mean', label: 'Mean error', value: n ? fmt.mm(mean) : '--', status: n ? statusFor(mean, this.opts.toleranceCm) : 'neutral' },
      { id: 'last', label: 'Last bite', value: n ? fmt.mm(this.placed[n - 1].error) : '--', status: n ? statusFor(this.placed[n - 1].error, this.opts.toleranceCm) : 'neutral' },
    ];
  }

  private complete(mode: ControlMode): void {
    const errs = this.placed.map((p) => p.error);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const max = Math.max(...errs);
    const tol = this.opts.toleranceCm;
    let spacingCv = 0;
    if (!this.opts.single && this.placed.length >= 3) {
      // spacing uniformity relative to the planned spacing between consecutive targets
      const ratios: number[] = [];
      for (let i = 1; i < this.placed.length; i++) {
        const planned = this.opts.targets[i].position.distanceTo(this.opts.targets[i - 1].position);
        const actual = this.placed[i].point.distanceTo(this.placed[i - 1].point);
        if (planned > 1e-4) ratios.push(actual / planned);
      }
      const gm = ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length);
      const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - gm) ** 2, 0) / Math.max(1, ratios.length));
      spacingCv = gm > 0 ? sd / gm : 0;
    }
    const score = scoreFrom([
      { value: mean, tol, weight: 50 },
      { value: max, tol: tol * 2, weight: 25 },
      ...(this.opts.single ? [] : [{ value: spacingCv, tol: 0.25, weight: 25 }]),
    ]);
    const metrics: Metric[] = [
      { id: 'mean', label: 'Mean placement error', value: fmt.mm(mean), target: `≤ ${fmt.mm(tol, 1)}`, status: statusFor(mean, tol) },
      { id: 'max', label: 'Largest error', value: fmt.mm(max), target: `≤ ${fmt.mm(tol * 2, 1)}`, status: statusFor(max, tol * 2) },
    ];
    if (!this.opts.single) metrics.push({ id: 'spacing', label: 'Bite spacing variation', value: fmt.pct(spacingCv * 100), target: '≤ 25%', status: statusFor(spacingCv, 0.25) });
    this.ctx.hint(null);
    this.finish({ score, metrics, mode, summary: `${this.title}: ${this.placed.length} points, mean error ${fmt.mm(mean)}`, raw: { meanErrorMm: mean * 10, maxErrorMm: max * 10, spacingCv } });
    this.opts.onComplete?.(this.result!);
  }

  async execute(): Promise<void> {
    this.begin();
    this.state = 'executing';
    this.cancelled = false;
    this.ctx.hint('Autonomous execution: the robot places each point on its target.');
    for (let i = 0; i < this.opts.targets.length && !this.cancelled; i++) {
      const t = this.opts.targets[i];
      this.ctx.arms.right.setTarget(t.position.clone().addScaledVector(t.normal, 0.35), t.normal);
      await wait(260);
      this.ctx.arms.right.setTarget(t.position, t.normal);
      await wait(180);
      const [u, v] = tangentBasis(t.normal);
      const p = t.position.clone().add(u.multiplyScalar((Math.random() - 0.5) * 0.008)).add(v.multiplyScalar((Math.random() - 0.5) * 0.008));
      this.state = 'executing';
      this.placeRobot(p);
      await wait(120);
    }
  }

  private placeRobot(p: THREE.Vector3): void {
    // reuse the placement logic under the autonomous label
    const saved = this.state;
    this.state = 'armed';
    this.place(p, 'autonomous');
    if (this.state === 'armed') this.state = saved;
  }
}

// ---------------------------------------------------------------------------
// Measurement

export interface MeasurePair { name: string; a: PointTarget; b: PointTarget; expectedCm: number; unitLabel?: string }
export interface MeasureOptions {
  title: string;
  instructions: string;
  pairs: MeasurePair[];
  toleranceCm: number;
  onMeasured?: (values: Record<string, number>) => void;
  onComplete?: (result: TaskResult) => void;
}

export class MeasureTask extends BaseTask {
  title: string;
  instructions: string;
  startLabel = 'Start measuring';
  private markers: THREE.Object3D[] = [];
  private objects: THREE.Object3D[] = [];
  private pairIndex = 0;
  private first: THREE.Vector3 | null = null;
  private values: Record<string, number> = {};

  constructor(ctx: SurgeryContext, surface: Surface, private opts: MeasureOptions) {
    super(ctx, surface);
    this.title = opts.title;
    this.instructions = opts.instructions;
  }

  mount(): void {
    this.ctx.arms.right.setTool('hook');
    this.ctx.arms.right.show(this.ctx.store.state.layers.instruments);
    this.showPair(0);
  }

  private showPair(i: number): void {
    for (const m of this.markers) this.ctx.overlays.remove(m);
    this.markers = [];
    const pair = this.opts.pairs[i];
    if (!pair) return;
    this.markers.push(this.ctx.overlays.marker(pair.a.position, pair.a.normal, { radius: 0.09, pulse: true, label: pair.a.label, cls: 'k-target' }));
    this.markers.push(this.ctx.overlays.marker(pair.b.position, pair.b.normal, { radius: 0.09, color: 0x9fb0b6, label: pair.b.label, cls: 'k-target' }));
    this.ctx.arms.right.setTarget(pair.a.position.clone().addScaledVector(pair.a.normal, 0.8), pair.a.normal);
  }

  unmount(): void {
    // measurements are annotations, not anatomy: they leave with the step
    for (const m of this.markers) this.ctx.overlays.remove(m);
    for (const o of this.objects) this.ctx.overlays.remove(o);
    this.markers = [];
    this.objects = [];
    this.ctx.store.set({ taskActive: false });
  }

  begin(): void {
    super.begin();
    for (const o of this.objects) this.ctx.overlays.remove(o);
    this.objects = [];
    this.values = {};
    this.pairIndex = 0;
    this.first = null;
    this.showPair(0);
    this.ctx.hint(`Measure <b>${this.opts.pairs[0].name}</b>: click the first landmark, then the second.`);
  }

  reset(): void { super.reset(); this.begin(); this.state = 'idle'; this.ctx.store.set({ taskActive: false }); this.ctx.hint(null); }

  pointer(kind: PointerKind, event: PointerEvent): boolean {
    if (this.state !== 'armed') return false;
    if (kind === 'down') { this.downPos = { x: event.clientX, y: event.clientY }; return false; }
    if (kind === 'move') {
      const tp = this.toolPoint(event);
      if (tp) this.ctx.arms.right.setTarget(tp.point, tp.normal);
      return false;
    }
    if (kind === 'up' && this.isClick(event)) {
      this.time += 0.41;
      const tp = this.toolPoint(event);
      if (!tp) return false;
      this.click(tp.point, this.mode);
    }
    return false;
  }

  private click(p: THREE.Vector3, mode: ControlMode): void {
    const pair = this.opts.pairs[this.pairIndex];
    if (!pair) return;
    const target = this.first ? pair.b : pair.a;
    // leaflet surfaces are curved, so the raycast hit can sit a few millimetres off the marker
    if (p.distanceTo(target.position) > 1.6) {
      this.ctx.hint(`Click closer to <b>${target.label ?? 'the landmark'}</b>.`);
      return;
    }
    if (!this.first) {
      this.first = p.clone();
      this.objects.push(this.ctx.overlays.dot(p, 0.035, 0xffffff));
      (this.markers[1].children[0] as THREE.Mesh & { material: THREE.MeshBasicMaterial }).material.color.set(AMBER);
      this.ctx.overlays.setPulse(this.markers[1], true);
      this.ctx.hint(`Now click <b>${pair.b.label ?? 'the second landmark'}</b>.`);
      return;
    }
    const d = this.first.distanceTo(p);
    this.values[pair.name] = d;
    this.objects.push(this.ctx.overlays.measurement(this.first, p, `${pair.name}: ${fmt.mm(d, 1)}`));
    this.first = null;
    this.pairIndex++;
    this.opts.onMeasured?.(this.values);
    if (this.pairIndex >= this.opts.pairs.length) this.complete(mode);
    else {
      this.showPair(this.pairIndex);
      this.ctx.hint(`Measure <b>${this.opts.pairs[this.pairIndex].name}</b>: click the first landmark, then the second.`);
    }
    this.onChange?.();
  }

  liveMetrics(): Metric[] | null {
    if (this.state !== 'armed') return null;
    return this.opts.pairs.map((p) => ({ id: p.name, label: p.name, value: this.values[p.name] != null ? fmt.mm(this.values[p.name], 1) : '--', status: 'neutral' as const }));
  }

  private complete(mode: ControlMode): void {
    const errs = this.opts.pairs.map((p) => Math.abs(this.values[p.name] - p.expectedCm));
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const score = scoreFrom([{ value: mean, tol: this.opts.toleranceCm, weight: 70 }, { value: Math.max(...errs), tol: this.opts.toleranceCm * 2, weight: 30 }]);
    const metrics: Metric[] = this.opts.pairs.map((p, i) => ({
      id: p.name, label: p.name, value: fmt.mm(this.values[p.name], 1), target: `ref ${fmt.mm(p.expectedCm, 1)}`, status: statusFor(errs[i], this.opts.toleranceCm),
    }));
    this.ctx.hint(null);
    this.finish({ score, metrics, mode, summary: `${this.title}: ${this.opts.pairs.map((p) => `${p.name} ${fmt.mm(this.values[p.name], 1)}`).join(', ')}`, raw: Object.fromEntries(this.opts.pairs.map((p) => [p.name, this.values[p.name] * 10])) });
    this.opts.onComplete?.(this.result!);
  }

  async execute(): Promise<void> {
    this.begin();
    this.state = 'executing';
    for (const pair of this.opts.pairs) {
      if (this.cancelled) return;
      this.state = 'armed';
      this.ctx.arms.right.setTarget(pair.a.position, pair.a.normal);
      await wait(400);
      this.click(pair.a.position.clone(), 'autonomous');
      this.ctx.arms.right.setTarget(pair.b.position, pair.b.normal);
      await wait(400);
      this.click(pair.b.position.clone(), 'autonomous');
    }
  }
}

// ---------------------------------------------------------------------------
// Neochord: attach and set the length of artificial chordae

export interface NeochordOptions {
  title: string;
  instructions: string;
  chords: { tip: PointTarget; edge: PointTarget; idealCm: number; label: string }[];
  toleranceCm: number;
  /** Apply a signed length error (cm) to the model so the leaflet responds. */
  apply: (errorCm: number, pairs: { from: THREE.Vector3; to: THREE.Vector3 }[]) => void;
  onComplete?: (result: TaskResult) => void;
}

export class NeochordTask extends BaseTask {
  title: string;
  instructions: string;
  startLabel = 'Place neochordae';
  private markers: THREE.Object3D[] = [];
  private objects: THREE.Object3D[] = [];
  private chordIndex = 0;
  private from: THREE.Vector3 | null = null;
  private pairs: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  private lengthCm = 0;
  private controlsEl: HTMLElement | null = null;
  private output: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private tieBtn: HTMLButtonElement | null = null;

  constructor(ctx: SurgeryContext, surface: Surface, private opts: NeochordOptions) {
    super(ctx, surface);
    this.title = opts.title;
    this.instructions = opts.instructions;
  }

  mount(): void {
    this.ctx.arms.right.setTool('needle');
    this.ctx.arms.right.show(this.ctx.store.state.layers.instruments);
    this.showChord(0);
  }

  private showChord(i: number): void {
    for (const m of this.markers) this.ctx.overlays.remove(m);
    this.markers = [];
    const c = this.opts.chords[i];
    if (!c) return;
    this.markers.push(this.ctx.overlays.marker(c.tip.position, c.tip.normal, { radius: 0.12, pulse: true, label: c.tip.label, cls: 'k-target' }));
    this.markers.push(this.ctx.overlays.marker(c.edge.position, c.edge.normal, { radius: 0.09, color: 0x9fb0b6, label: c.edge.label, cls: 'k-target' }));
  }

  unmount(): void {
    for (const m of this.markers) this.ctx.overlays.remove(m);
    this.markers = [];
    if (!this.result) for (const o of this.objects) this.ctx.overlays.remove(o);
    this.ctx.store.set({ taskActive: false });
  }

  begin(): void {
    super.begin();
    for (const o of this.objects) this.ctx.overlays.remove(o);
    this.objects = [];
    this.pairs = [];
    this.chordIndex = 0;
    this.from = null;
    this.showChord(0);
    this.ctx.hint(`Chord ${1} of ${this.opts.chords.length}: click the <b>papillary muscle head</b>, then the <b>free edge</b> of P2.`);
    this.refreshControls();
  }

  reset(): void { super.reset(); this.begin(); this.state = 'idle'; this.ctx.store.set({ taskActive: false }); this.ctx.hint(null); this.refreshControls(); }

  controls(): HTMLElement | null {
    if (!this.controlsEl) {
      this.controlsEl = el('div', 'slider-row');
      this.refreshControls();
    }
    return this.controlsEl;
  }

  private refreshControls(): void {
    if (!this.controlsEl) return;
    const ready = this.pairs.length === this.opts.chords.length && this.state !== 'done';
    if (!ready) {
      this.controlsEl.innerHTML = `<span>Neochord length is set after both chords are anchored.</span>`;
      return;
    }
    const ideal = this.opts.chords[0].idealCm;
    const initial = this.lengthCm || ideal + 0.35;
    this.controlsEl.innerHTML = `
      <span>Neochord length (both chords)</span><output id="nc-out">${(initial * 10).toFixed(1)} mm</output>
      <input type="range" id="nc-slider" min="${((ideal - 0.6) * 10).toFixed(1)}" max="${((ideal + 0.6) * 10).toFixed(1)}" step="0.1" value="${(initial * 10).toFixed(1)}" aria-label="Neochord length in millimetres" />
      <span style="grid-column:1/-1;font-size:12px;color:var(--text-faint)">Reference: the anterior leaflet free edge sits ${fmt.mm(ideal, 1)} from the papillary head at coaptation level. Adjust until P2 meets the anterior leaflet without prolapse or restriction.</span>
      <button class="btn is-primary" id="nc-tie" style="grid-column:1/-1">Tie the neochordae</button>
    `;
    this.slider = this.controlsEl.querySelector('#nc-slider')!;
    this.output = this.controlsEl.querySelector('#nc-out')!;
    this.tieBtn = this.controlsEl.querySelector('#nc-tie')!;
    this.lengthCm = initial;
    this.applyPreview();
    this.slider.addEventListener('input', () => {
      this.lengthCm = parseFloat(this.slider!.value) / 10;
      this.output!.textContent = `${(this.lengthCm * 10).toFixed(1)} mm`;
      this.applyPreview();
    });
    this.tieBtn.addEventListener('click', () => this.complete(this.mode));
  }

  private applyPreview(): void {
    const err = this.lengthCm - this.opts.chords[0].idealCm;
    this.opts.apply(err, this.pairs);
  }

  pointer(kind: PointerKind, event: PointerEvent): boolean {
    if (this.state !== 'armed') return false;
    if (kind === 'down') { this.downPos = { x: event.clientX, y: event.clientY }; return false; }
    if (kind === 'move') {
      const tp = this.toolPoint(event);
      if (tp) this.ctx.arms.right.setTarget(tp.point, tp.normal);
      return false;
    }
    if (kind === 'up' && this.isClick(event)) {
      this.time += 0.29;
      const tp = this.toolPoint(event);
      if (tp) this.click(tp.point);
    }
    return false;
  }

  private click(p: THREE.Vector3): void {
    const c = this.opts.chords[this.chordIndex];
    if (!c) return;
    if (!this.from) {
      if (p.distanceTo(c.tip.position) > 0.6) { this.ctx.hint('Anchor the chord on the <b>papillary muscle head</b> (amber ring).'); return; }
      this.from = p.clone();
      this.objects.push(this.ctx.overlays.dot(p, 0.04, PTFE_WHITE));
      (this.markers[1].children[0] as THREE.Mesh & { material: THREE.MeshBasicMaterial }).material.color.set(AMBER);
      this.ctx.overlays.setPulse(this.markers[1], true);
      this.ctx.hint('Now pass the suture through the <b>free edge</b> of P2 (amber ring).');
      return;
    }
    if (p.distanceTo(c.edge.position) > 0.6) { this.ctx.hint('Pass the suture through the <b>free edge</b> marker.'); return; }
    const err = Math.max(p.distanceTo(c.edge.position), this.from.distanceTo(c.tip.position));
    this.pairs.push({ from: this.from, to: p.clone() });
    this.objects.push(this.ctx.overlays.dot(p, 0.03, PTFE_WHITE));
    this.from = null;
    this.chordIndex++;
    void err;
    if (this.chordIndex < this.opts.chords.length) {
      this.showChord(this.chordIndex);
      this.ctx.hint(`Chord ${this.chordIndex + 1} of ${this.opts.chords.length}: click the <b>papillary muscle head</b>, then the <b>free edge</b>.`);
    } else {
      for (const m of this.markers) this.ctx.overlays.remove(m);
      this.markers = [];
      this.ctx.hint('Both chords anchored. Set their length in the panel, then tie.');
    }
    this.refreshControls();
    this.onChange?.();
  }

  liveMetrics(): Metric[] | null {
    if (this.state !== 'armed') return null;
    return [{ id: 'chords', label: 'Chords anchored', value: `${this.pairs.length} / ${this.opts.chords.length}`, status: 'neutral' }];
  }

  private complete(mode: ControlMode): void {
    const ideal = this.opts.chords[0].idealCm;
    const err = this.lengthCm - ideal;
    const anchorErr = this.pairs.reduce((a, p, i) => a + p.from.distanceTo(this.opts.chords[i].tip.position) + p.to.distanceTo(this.opts.chords[i].edge.position), 0) / (2 * this.pairs.length);
    const tol = this.opts.toleranceCm;
    const score = scoreFrom([{ value: Math.abs(err), tol, weight: 70 }, { value: anchorErr, tol: 0.15, weight: 30 }]);
    const metrics: Metric[] = [
      { id: 'len', label: 'Neochord length', value: fmt.mm(this.lengthCm, 1), target: `ref ${fmt.mm(ideal, 1)}`, status: statusFor(Math.abs(err), tol) },
      { id: 'err', label: err > 0 ? 'Residual prolapse' : 'Leaflet restriction', value: fmt.mm(Math.abs(err), 1), target: `≤ ${fmt.mm(tol, 1)}`, status: statusFor(Math.abs(err), tol) },
      { id: 'anchor', label: 'Anchoring accuracy', value: fmt.mm(anchorErr), target: '≤ 1.5 mm', status: statusFor(anchorErr, 0.15) },
    ];
    this.opts.apply(err, this.pairs);
    if (this.controlsEl) this.controlsEl.innerHTML = `<span>Neochordae tied at ${fmt.mm(this.lengthCm, 1)}.</span>`;
    this.ctx.hint(null);
    this.finish({ score, metrics, mode, summary: `${this.title}: length error ${fmt.mm(Math.abs(err), 1)} (${err > 0 ? 'long' : 'short'})`, raw: { lengthErrorMm: err * 10, anchorErrorMm: anchorErr * 10 } });
    this.opts.onComplete?.(this.result!);
  }

  async execute(): Promise<void> {
    this.begin();
    for (const c of this.opts.chords) {
      if (this.cancelled) return;
      this.ctx.arms.right.setTarget(c.tip.position, c.tip.normal);
      await wait(420);
      this.click(c.tip.position.clone());
      this.ctx.arms.right.setTarget(c.edge.position, c.edge.normal);
      await wait(420);
      this.click(c.edge.position.clone());
    }
    this.lengthCm = this.opts.chords[0].idealCm + (Math.random() - 0.5) * 0.01;
    if (this.slider) { this.slider.value = (this.lengthCm * 10).toFixed(1); this.output!.textContent = `${(this.lengthCm * 10).toFixed(1)} mm`; }
    this.applyPreview();
    await wait(600);
    this.complete('autonomous');
  }
}

// ---------------------------------------------------------------------------
// Choice

export interface ChoiceOption { id: string; title: string; desc: string; score: number; feedback: string }
export interface ChoiceOptions {
  title: string;
  instructions: string;
  options: ChoiceOption[];
  onComplete?: (result: TaskResult, option: ChoiceOption) => void;
}

export class ChoiceTask extends BaseTask {
  title: string;
  instructions: string;
  robotic = false;
  private root: HTMLElement | null = null;

  constructor(ctx: SurgeryContext, private opts: ChoiceOptions) {
    super(ctx, meshSurface([]));
    this.title = opts.title;
    this.instructions = opts.instructions;
  }

  mount(): void { this.state = 'armed'; }
  unmount(): void {}
  begin(): void { this.state = 'armed'; }
  reset(): void { this.result = null; this.state = 'armed'; this.render(); this.onChange?.(); }
  pointer(): boolean { return false; }
  async execute(): Promise<void> {}

  controls(): HTMLElement {
    if (!this.root) this.root = el('div', 'options');
    this.render();
    return this.root;
  }

  private render(): void {
    if (!this.root) return;
    this.root.innerHTML = '';
    for (const o of this.opts.options) {
      const b = el('button', 'option');
      b.type = 'button';
      b.innerHTML = `<span><span class="op-title">${o.title}</span><br><span class="op-desc">${o.desc}</span></span>`;
      if (this.result) {
        b.disabled = true;
        if (this.result.raw?.choice === this.opts.options.indexOf(o)) b.classList.add('is-selected');
      }
      b.addEventListener('click', () => this.choose(o));
      this.root!.appendChild(b);
    }
    if (this.result) {
      const chosen = this.opts.options[this.result.raw!.choice];
      this.root.appendChild(el('div', 'note', `<b>${chosen.title}.</b> ${chosen.feedback}`));
    }
  }

  private choose(o: ChoiceOption): void {
    const idx = this.opts.options.indexOf(o);
    this.finish({
      score: o.score,
      metrics: [{ id: 'choice', label: 'Decision', value: o.title, status: o.score >= 90 ? 'ok' : o.score >= 60 ? 'warn' : 'bad' }],
      mode: this.mode,
      summary: `${this.title}: ${o.title}`,
      raw: { choice: idx },
    });
    this.render();
    this.opts.onComplete?.(this.result!, o);
  }
}
