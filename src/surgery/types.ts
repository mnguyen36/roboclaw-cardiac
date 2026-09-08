/** Shared types for procedures, steps and precision tasks. */
import type * as THREE from 'three';
import type { SceneManager, CameraPose } from '../scene/SceneManager';
import type { HeartModel } from '../scene/HeartBuilder';
import type { Overlays } from '../scene/overlays';
import type { Physiology } from '../app/physiology';
import type { RobotArm } from '../scene/Instruments';
import type { Graft } from '../scene/Graft';
import type { MitralValve } from '../scene/MitralValve';
import type { Store, AppState, ControlMode } from '../app/state';

export type MetricStatus = 'ok' | 'warn' | 'bad' | 'neutral';

export interface Metric {
  id: string;
  label: string;
  value: string;
  /** Tolerance or target shown next to the value. */
  target?: string;
  status: MetricStatus;
}

export interface TaskResult {
  score: number;
  metrics: Metric[];
  mode: ControlMode;
  summary: string;
  /** Raw numbers kept for the report. */
  raw?: Record<string, number>;
}

export type PointerKind = 'down' | 'move' | 'up' | 'leave';

export interface Task {
  /** Short heading shown in the task card. */
  title: string;
  /** What the user has to do, in plain words. */
  instructions: string;
  /** Primary button label for the action that starts or arms the task. */
  startLabel?: string;
  /** Whether the task can be executed by the autonomous robot. */
  robotic: boolean;
  /** Called when the step becomes active (draw plan overlays etc). */
  mount(): void;
  /** Cleanup when leaving the step. */
  unmount(): void;
  /** Arm the interactive task (user drives). */
  begin(): void;
  /** Let the robot execute the plan. */
  execute(): Promise<void>;
  /** Reset the attempt. */
  reset(): void;
  /** Pointer routing from the viewport. Return true to keep the orbit controls disabled. */
  pointer(kind: PointerKind, event: PointerEvent): boolean;
  /** Called every frame. */
  update(dt: number): void;
  /** Live metrics for the HUD while in progress. */
  liveMetrics(): Metric[] | null;
  /** Result once complete, otherwise null. */
  result: TaskResult | null;
  /** Fired when the result changes. */
  onChange: (() => void) | null;
  /** Optional extra controls rendered inside the task card (returns an element). */
  controls?(): HTMLElement | null;
}

export interface SurgeryContext {
  sm: SceneManager;
  heart: HeartModel;
  overlays: Overlays;
  phys: Physiology;
  arms: { right: RobotArm; left: RobotArm };
  graft: Graft | null;
  valve: MitralValve | null;
  store: Store<AppState>;
  hint(text: string | null): void;
  flyTo(pose: CameraPose, duration?: number): Promise<void>;
  showScene(which: 'heart' | 'valve'): void;
  /** Camera pose looking at a surface point from a distance along its normal. */
  poseAt(point: THREE.Vector3, normal: THREE.Vector3, distance: number, tilt?: number): CameraPose;
  data: Record<string, unknown>;
  results: Record<string, TaskResult>;
  setLabelsFilter(filter: ((id: string) => boolean) | null): void;
  /** Refresh the right-hand panel (e.g. after data changes). */
  refreshPanel(): void;
}

export interface StepDef {
  id: string;
  title: string;
  /** Short line under the title in the step list. */
  short: string;
  instrument: string;
  /** Description paragraphs (plain text; each entry becomes a paragraph). */
  description: string[];
  note?: string;
  scene?: 'heart' | 'valve';
  pose?: (ctx: SurgeryContext) => CameraPose | null;
  onEnter?: (ctx: SurgeryContext) => void | Promise<void>;
  onExit?: (ctx: SurgeryContext) => void;
  task?: (ctx: SurgeryContext) => Task;
  /** For non-task steps: an animated action with its own button. */
  action?: { label: string; run: (ctx: SurgeryContext) => Promise<void>; doneLabel?: string };
  /** Landmark labels to show for this step (ids). */
  labels?: string[];
}

export interface ProcedureDef {
  id: string;
  name: string;
  short: string;
  patient: string;
  indication: string;
  icon: string;
  steps: StepDef[];
}

export function grade(score: number): { label: string; cls: 'ok' | 'warn' | 'bad' } {
  if (score >= 90) return { label: 'Excellent', cls: 'ok' };
  if (score >= 75) return { label: 'Good', cls: 'ok' };
  if (score >= 60) return { label: 'Acceptable', cls: 'warn' };
  return { label: 'Revise', cls: 'bad' };
}

export function statusFor(value: number, tol: number, warnFactor = 1, badFactor = 2): MetricStatus {
  if (value <= tol * warnFactor) return 'ok';
  if (value <= tol * badFactor) return 'warn';
  return 'bad';
}

export const fmt = {
  mm: (cm: number, digits = 2) => `${(cm * 10).toFixed(digits)} mm`,
  pct: (v: number) => `${Math.round(v)}%`,
};
