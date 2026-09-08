/** Minimal observable store for UI state. */
export type ControlMode = 'manual' | 'assisted' | 'autonomous';

export interface Layers {
  coronaries: boolean;
  veins: boolean;
  labels: boolean;
  instruments: boolean;
}

export interface AppState {
  procedureId: string | null;
  stepIndex: number;
  controlMode: ControlMode;
  /** Motion scaling for robot-assisted mode (hand:instrument). */
  motionScale: number;
  tremorFilter: boolean;
  layers: Layers;
  view: string;
  /** Whether the current step's task is running. */
  taskActive: boolean;
  /** Exploded view: the coronary and venous tree lifts off the ghosted myocardium. */
  exploded: boolean;
  /** Left / right rails open on narrow screens. */
  leftOpen: boolean;
  rightOpen: boolean;
}

export const initialState: AppState = {
  procedureId: null,
  stepIndex: 0,
  controlMode: 'assisted',
  motionScale: 1,
  tremorFilter: true,
  layers: { coronaries: true, veins: true, labels: false, instruments: true },
  view: 'anterior',
  taskActive: false,
  exploded: false,
  leftOpen: false,
  rightOpen: false,
};

type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private listeners = new Set<Listener<T>>();
  constructor(public state: T) {}

  set(patch: Partial<T>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const MODE_LABELS: Record<ControlMode, string> = {
  manual: 'Human hand',
  assisted: 'Robot-assisted',
  autonomous: 'Autonomous robot',
};

export const MODE_DESCRIPTIONS: Record<ControlMode, string> = {
  manual: 'You guide the instrument directly. Physiological tremor (8 to 12 Hz, about 0.4 mm) is simulated on the tip.',
  assisted: 'You teleoperate the robot. Tremor is filtered and your hand motion is scaled down, the way a surgical console works.',
  autonomous: 'The robot executes the planned path itself. You supervise and approve each step.',
};
