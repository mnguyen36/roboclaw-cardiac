/**
 * Application orchestrator: scene, patient, procedures, panels and interaction routing.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { SceneManager, type CameraPose } from '../scene/SceneManager';
import type { QualitySettings, QualityTier } from '../scene/quality';
import { buildHeart, type HeartModel } from '../scene/HeartBuilder';
import { explodePoint } from '../scene/heartbeat';
import { Overlays } from '../scene/overlays';
import { RobotArm } from '../scene/Instruments';
import { MitralValve } from '../scene/MitralValve';
import type { Graft } from '../scene/Graft';
import { Physiology, formatClock } from './physiology';
import { Store, initialState, MODE_LABELS, MODE_DESCRIPTIONS, type AppState, type ControlMode } from './state';
import { buildLayout, el, type Layout } from '../ui/layout';
import { VitalsMonitor } from '../ui/Vitals';
import { icons } from '../ui/icons';
import type { ProcedureDef, StepDef, Task, TaskResult, SurgeryContext, Metric } from '../surgery/types';
import { grade } from '../surgery/types';
import { cabgProcedure } from '../surgery/cabg';
import { mitralProcedure } from '../surgery/mitral';

const PROCEDURES: ProcedureDef[] = [cabgProcedure, mitralProcedure];

interface StepRuntime {
  def: StepDef;
  task: Task | null;
  actionDone: boolean;
  actionRunning: boolean;
  skipped: boolean;
}

export class App {
  private layout: Layout;
  private sm: SceneManager;
  private phys = new Physiology();
  private store = new Store<AppState>({ ...initialState });
  private vitals: VitalsMonitor;
  private heart!: HeartModel;
  private overlays!: Overlays;
  private arms!: { right: RobotArm; left: RobotArm };
  private valve!: MitralValve;
  private graft: Graft | null = null;
  private ctx!: SurgeryContext;
  private procedure: ProcedureDef | null = null;
  private steps: StepRuntime[] = [];
  private results: Record<string, TaskResult> = {};
  private labels = new Map<string, CSS2DObject>();
  private labelFilter: ((id: string) => boolean) | null = null;
  private heartCenter = new THREE.Vector3();
  private activeScene: 'heart' | 'valve' = 'heart';
  private pointerCaptured = false;
  private unsubTask: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.layout = buildLayout(root);
    this.sm = new SceneManager(this.layout.viewport);
    this.sm.renderer.localClippingEnabled = true;
    this.vitals = new VitalsMonitor(this.layout.vitalsCanvas, this.layout.vitalsNumbers, this.phys);
    this.sm.start();
    this.bindChrome();
    void this.init();
  }

  // ------------------------------------------------------------------ boot
  private async init(): Promise<void> {
    const { loadingText, loadingBar, loading } = this.layout;
    this.heart = await buildHeart({
      resolution: 150,
      onProgress: (label, f) => { loadingText.textContent = label; loadingBar.style.width = `${Math.round(f * 100)}%`; },
    });
    this.sm.scene.add(this.heart.group);
    this.heart.heart.geometry.computeBoundingSphere();
    this.heartCenter.copy(this.heart.heart.geometry.boundingSphere!.center);
    this.sm.lampTarget.position.copy(this.heartCenter);
    this.sm.controls.target.copy(this.heartCenter).add(new THREE.Vector3(0, 0.5, 0));
    this.sm.camera.position.copy(this.heartCenter).add(new THREE.Vector3(1.5, 4, 34));

    this.overlays = new Overlays(this.sm, this.heart);
    this.overlays.onLabelsChanged = () => this.updateLabels();
    this.arms = {
      right: new RobotArm(this.heartCenter.clone().add(new THREE.Vector3(-9, 26, 18)), 'needle'),
      left: new RobotArm(this.heartCenter.clone().add(new THREE.Vector3(12, 26, 17)), 'forceps'),
    };
    this.sm.scene.add(this.arms.right.group, this.arms.left.group);
    this.valve = new MitralValve();
    this.valve.group.position.copy(this.heartCenter).add(new THREE.Vector3(0, 0, 0));
    this.valve.group.visible = false;
    this.sm.scene.add(this.valve.group);
    this.buildLabels();
    this.buildContext();
    this.sm.onQualityChange = (s) => { this.applyMaterialQuality(s); this.renderStatus(); };
    this.applyMaterialQuality(this.sm.quality.settings);
    if (this.sm.gpu.software) {
      console.warn(`[perf] no GPU acceleration: "${this.sm.gpu.renderer}". Rendering on the CPU; quality is reduced automatically.`);
    }
    this.renderProcedurePicker();
    this.renderViewControls();
    this.renderStatus();
    this.renderPanel();
    this.sm.onFrame((dt) => this.frame(dt));
    this.bindPointer();
    loading.classList.add('is-hidden');
  }

  private buildContext(): void {
    this.ctx = {
      sm: this.sm,
      heart: this.heart,
      overlays: this.overlays,
      phys: this.phys,
      arms: this.arms,
      graft: null,
      valve: this.valve,
      store: this.store,
      hint: (t) => this.hint(t),
      flyTo: (pose, d) => this.sm.flyTo(pose, d),
      showScene: (w) => this.showScene(w),
      poseAt: (point, normal, distance, tilt = 0.3) => {
        const up = new THREE.Vector3(0, 1, 0);
        const dir = normal.clone().normalize().addScaledVector(up, tilt).normalize();
        return { position: point.clone().addScaledVector(dir, distance), target: point.clone(), fov: 32 };
      },
      data: {},
      results: this.results,
      setLabelsFilter: (f) => { this.labelFilter = f; this.updateLabels(); },
      refreshPanel: () => this.renderPanel(),
    };
    Object.defineProperty(this.ctx, 'graft', { get: () => this.graft, set: (g: Graft | null) => { this.graft = g; } });
  }

  /**
   * Clearcoat is the single most expensive feature in the tissue shader, so the tier
   * switches it off before anything else visible. Sheen goes only at the lowest tier.
   */
  private applyMaterialQuality(s: QualitySettings): void {
    if (!this.heart) return;
    const t = this.heart.tissueMaterial;
    const setCoat = (m: THREE.MeshPhysicalMaterial, on: number) => {
      if (m.clearcoat === on) return;
      m.clearcoat = on;
      m.needsUpdate = true;
    };
    setCoat(t, s.clearcoat ? 0.6 : 0);
    setCoat(this.heart.arteryMaterial, s.clearcoat ? 1 : 0);
    setCoat(this.heart.veinMaterial, s.clearcoat ? 0.8 : 0);
    const sheen = s.sheen ? 0.35 : 0;
    if (t.sheen !== sheen) { t.sheen = sheen; t.needsUpdate = true; }
    const aSheen = s.sheen ? 0.25 : 0;
    if (this.heart.arteryMaterial.sheen !== aSheen) { this.heart.arteryMaterial.sheen = aSheen; this.heart.arteryMaterial.needsUpdate = true; }
    for (const m of [t, this.heart.arteryMaterial, this.heart.veinMaterial]) m.envMapIntensity = s.envIntensity + 0.3;
    this.heart.setTissueFeatures({ detail: s.detailNormals, subsurface: s.subsurface });
    this.sm.invalidateShadows();
  }

  // ------------------------------------------------------------------ frame
  private vitalsAccum = 0;
  private frame(dt: number): void {
    this.phys.update(dt);
    this.heart.beat.uBeat.value = this.phys.contraction;
    // the monitor is a 2D canvas redraw; 30 Hz is indistinguishable and halves its cost
    this.vitalsAccum += dt;
    if (this.vitalsAccum >= 1 / 30) { this.vitals.update(this.vitalsAccum); this.vitalsAccum = 0; }
    this.arms.right.update(dt);
    this.arms.left.update(dt);
    this.graft?.update(dt, this.phys.contraction);
    if (this.activeScene === 'valve') this.valve.update(dt);
    const step = this.currentStep();
    step?.task?.update(dt);
    this.updateLiveMetrics();
    this.updateClock();
    this.updateExplode(dt);
    this.updatePerfChip(dt);
  }

  private lastClock = '';
  private updateClock(): void {
    const v = this.phys.vitals();
    const text = formatClock(v.clampSeconds);
    if (text !== this.lastClock) {
      this.lastClock = text;
      this.layout.clockValue.textContent = text;
      this.layout.clock.classList.toggle('is-running', v.crossClamped);
    }
    const pill = this.layout.phasePill;
    const label = v.rhythm === 'sinus' ? (v.onBypass ? 'Sinus rhythm, on bypass' : 'Sinus rhythm') : v.rhythm === 'fibrillation' ? 'Ventricular fibrillation' : 'Cardioplegic arrest';
    if (pill.dataset.label !== label) {
      pill.dataset.label = label;
      pill.querySelector('span')!.textContent = label;
      pill.classList.toggle('is-live', v.rhythm === 'sinus');
      pill.classList.toggle('is-arrest', v.rhythm !== 'sinus');
    }
  }

  private lastMetricsKey = '';
  private updateLiveMetrics(): void {
    const step = this.currentStep();
    const metrics = step?.task?.liveMetrics() ?? null;
    const box = this.layout.liveMetrics;
    if (!metrics) {
      if (this.lastMetricsKey !== '') { this.lastMetricsKey = ''; box.classList.remove('is-visible'); }
      return;
    }
    const key = metrics.map((m) => `${m.id}:${m.value}:${m.status}`).join('|');
    if (key === this.lastMetricsKey) return;
    this.lastMetricsKey = key;
    box.innerHTML = metrics.map((m) => `<div class="lm"><small>${m.label}</small><b class="is-${m.status}">${m.value}</b></div>`).join('');
    box.classList.add('is-visible');
  }

  // ------------------------------------------------------------------ labels
  private buildLabels(): void {
    for (const lm of this.heart.landmarks) {
      const div = document.createElement('div');
      div.className = `lbl k-${lm.kind}`;
      div.textContent = lm.label;
      const obj = new CSS2DObject(div);
      obj.position.copy(lm.position);
      obj.center.set(0, 0.5);
      obj.visible = false;
      this.heart.group.add(obj);
      this.labels.set(lm.id, obj);
    }
    this.updateLabels();
  }

  private updateLabels(): void {
    const on = this.store.state.layers.labels && this.activeScene === 'heart';
    let anyVisible = false;
    for (const [id, obj] of this.labels) {
      obj.visible = on && (this.labelFilter ? this.labelFilter(id) : true);
      anyVisible = anyVisible || obj.visible;
    }
    this.sm.setLabelsActive(anyVisible || this.overlays.hasLabels());
  }

  // ------------------------------------------------------------------ exploded view
  private explodeAmount = 0;
  private explodeTarget = 0;
  private vesselLabels: CSS2DObject[] = [];
  private readonly EXPLODE_MAX = 2.6; // cm

  /**
   * Lifts the coronary and venous tree radially off the heart and ghosts the myocardium
   * behind it. Picking is suppressed while exploded: the displacement happens in the vertex
   * shader, so the raycaster would still be testing the seated geometry.
   */
  setExploded(on: boolean): void {
    if (this.activeScene !== 'heart') return;
    this.store.set({ exploded: on });
    this.explodeTarget = on ? this.EXPLODE_MAX : 0;
    if (on) this.buildVesselLabels();
    else this.clearVesselLabels();
    this.renderViewControls();
    this.renderStatus();
  }

  private buildVesselLabels(): void {
    this.clearVesselLabels();
    for (const v of Object.values(this.heart.vessels)) {
      const div = document.createElement('div');
      div.className = `lbl ${v.def.kind === 'artery' ? 'k-coronary' : 'k-vessel'}`;
      div.textContent = v.def.label;
      const obj = new CSS2DObject(div);
      obj.center.set(0, 0.5);
      obj.userData.vessel = v.def.id;
      this.sm.scene.add(obj);
      this.vesselLabels.push(obj);
    }
    this.sm.setLabelsActive(true);
  }

  private clearVesselLabels(): void {
    for (const l of this.vesselLabels) { l.element.remove(); l.removeFromParent(); }
    this.vesselLabels = [];
    this.updateLabels();
  }

  private updateExplode(dt: number): void {
    const target = this.explodeTarget;
    if (Math.abs(this.explodeAmount - target) < 1e-4 && this.vesselLabels.length === 0) return;
    this.explodeAmount += (target - this.explodeAmount) * Math.min(1, dt * 4.5);
    if (Math.abs(this.explodeAmount - target) < 1e-4) this.explodeAmount = target;
    this.heart.explode.value = this.explodeAmount;

    // ghost the myocardium so the tree reads against it rather than through it
    const t = this.explodeAmount / this.EXPLODE_MAX;
    const mat = this.heart.tissueMaterial;
    const opacity = 1 - 0.72 * t;
    if (mat.opacity !== opacity) {
      mat.opacity = opacity;
      const wantsTransparent = t > 0.001;
      if (mat.transparent !== wantsTransparent) {
        mat.transparent = wantsTransparent;
        mat.depthWrite = !wantsTransparent;
        mat.needsUpdate = true;
      }
    }

    for (const label of this.vesselLabels) {
      const v = this.heart.vessels[label.userData.vessel as string];
      if (!v) continue;
      const mid = v.curve.getPointAt(0.5);
      label.position.copy(explodePoint(mid, this.heart.base, this.heart.axis, this.explodeAmount));
    }
    if (this.explodeAmount === 0 && target === 0) this.clearVesselLabels();
  }

  // ------------------------------------------------------------------ scene switching
  private showScene(which: 'heart' | 'valve'): void {
    if (which !== 'heart' && this.store.state.exploded) this.setExploded(false);
    this.activeScene = which;
    this.heart.group.visible = which === 'heart';
    if (this.graft) this.graft.group.visible = which === 'heart';
    this.overlays.group.visible = true;
    this.valve.group.visible = which === 'valve';
    this.sm.keyLight.intensity = which === 'valve' ? 3.2 : 2.6;
    this.updateLabels();
    this.renderStatus();
  }

  // ------------------------------------------------------------------ chrome
  private bindChrome(): void {
    const L = this.layout;
    L.btnReport.addEventListener('click', () => this.openReport());
    L.btnSettings.addEventListener('click', () => this.openSettings());
    L.btnLeft.addEventListener('click', () => this.store.set({ leftOpen: !this.store.state.leftOpen, rightOpen: false }));
    L.btnRight.addEventListener('click', () => this.store.set({ rightOpen: !this.store.state.rightOpen, leftOpen: false }));
    L.modalBackdrop.addEventListener('click', (e) => { if (e.target === L.modalBackdrop) this.closeModal(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (L.modalBackdrop.classList.contains('is-open')) this.closeModal();
        else this.currentStep()?.task?.reset();
      }
    });
    this.store.on((s, prev) => {
      document.getElementById('rail-left')!.classList.toggle('is-open', s.leftOpen);
      document.getElementById('rail-right')!.classList.toggle('is-open', s.rightOpen);
      if (s.layers !== prev.layers) this.applyLayers();
      if (s.controlMode !== prev.controlMode || s.motionScale !== prev.motionScale || s.tremorFilter !== prev.tremorFilter) this.renderStatus();
      if (s.taskActive !== prev.taskActive) this.layout.viewport.classList.toggle('is-picking', s.taskActive);
    });
  }

  private applyLayers(): void {
    const l = this.store.state.layers;
    for (const v of Object.values(this.heart.vessels)) v.mesh.visible = v.def.kind === 'artery' ? l.coronaries : l.veins;
    this.updateLabels();
    const anyArmShown = this.currentStep()?.task != null || this.procedure != null;
    this.arms.right.group.visible = l.instruments && anyArmShown && this.arms.right.group.visible;
    if (!l.instruments) { this.arms.right.group.visible = false; this.arms.left.group.visible = false; }
    this.renderViewControls();
  }

  private hint(text: string | null): void {
    const h = this.layout.hint;
    if (!text) { h.classList.remove('is-visible'); return; }
    h.innerHTML = text;
    h.classList.add('is-visible');
  }

  // ------------------------------------------------------------------ view controls
  private renderViewControls(): void {
    const c = this.layout.viewControls;
    const s = this.store.state;
    const views: [string, string][] = [['anterior', 'Front'], ['left', 'Left'], ['right', 'Right'], ['posterior', 'Back'], ['superior', 'Top']];
    c.innerHTML = `
      <div class="seg" role="group" aria-label="Camera view">
        ${views.map(([id, label]) => `<button type="button" data-view="${id}" class="${s.view === id ? 'is-active' : ''}">${label}</button>`).join('')}
        <button type="button" data-view="step" class="is-amber ${s.view === 'step' ? 'is-active' : ''}" title="Return to this step's view">Step view</button>
      </div>
      <div class="seg" role="group" aria-label="Layers">
        <button type="button" data-layer="coronaries" class="${s.layers.coronaries ? 'is-active' : ''}">Coronaries</button>
        <button type="button" data-layer="veins" class="${s.layers.veins ? 'is-active' : ''}">Veins</button>
        <button type="button" data-layer="labels" class="${s.layers.labels ? 'is-active' : ''}">Labels</button>
        <button type="button" data-layer="instruments" class="${s.layers.instruments ? 'is-active' : ''}">Instruments</button>
      </div>
      <div class="seg" role="group" aria-label="Vascular tree">
        <button type="button" data-explode class="is-amber ${s.exploded ? 'is-active' : ''}" title="Lift the coronary and venous tree off the heart">Exploded view</button>
      </div>`;
    c.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view!)));
    c.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.layer as keyof AppState['layers'];
      this.store.set({ layers: { ...this.store.state.layers, [key]: !this.store.state.layers[key] } });
    }));
    c.querySelector<HTMLButtonElement>('[data-explode]')?.addEventListener('click', () => this.setExploded(!this.store.state.exploded));
  }

  private setView(id: string): void {
    this.store.set({ view: id });
    this.renderViewControls();
    if (id === 'step') {
      const pose = this.currentStep()?.def.pose?.(this.ctx);
      if (pose) void this.sm.flyTo(pose, 1.2);
      return;
    }
    if (this.activeScene === 'valve') {
      const target = this.valve.group.localToWorld(new THREE.Vector3(0, -0.5, 0.15));
      const dirs: Record<string, THREE.Vector3> = {
        anterior: new THREE.Vector3(0, 1, 0.9), left: new THREE.Vector3(1, 1, 0.4), right: new THREE.Vector3(-1, 1, 0.4), posterior: new THREE.Vector3(0, 1, -0.9), superior: new THREE.Vector3(0.001, 1, 0),
      };
      void this.sm.flyTo({ position: target.clone().addScaledVector(dirs[id].normalize(), 10), target, fov: 32 }, 1.2);
      return;
    }
    const c = this.heartCenter;
    const poses: Record<string, CameraPose> = {
      anterior: { position: c.clone().add(new THREE.Vector3(1.5, 4, 34)), target: c.clone().add(new THREE.Vector3(0, 0.5, 0)), fov: 32 },
      left: { position: c.clone().add(new THREE.Vector3(33, 5, 8)), target: c.clone().add(new THREE.Vector3(0, 0.5, 0)), fov: 32 },
      right: { position: c.clone().add(new THREE.Vector3(-32, 7, 6)), target: c.clone().add(new THREE.Vector3(0, 0.5, 0)), fov: 32 },
      posterior: { position: c.clone().add(new THREE.Vector3(-4, 5, -34)), target: c.clone().add(new THREE.Vector3(0, 0.5, 0)), fov: 32 },
      superior: { position: c.clone().add(new THREE.Vector3(0.5, 36, 5)), target: c.clone().add(new THREE.Vector3(0, 0.5, 0)), fov: 32 },
    };
    void this.sm.flyTo(poses[id], 1.2);
  }

  private renderStatus(): void {
    const s = this.store.state;
    const modeText = s.controlMode === 'assisted' ? `Robot-assisted ${s.motionScale}:1${s.tremorFilter ? ', tremor filtered' : ''}` : MODE_LABELS[s.controlMode];
    this.layout.viewportStatus.innerHTML = `
      <span class="chip ${s.controlMode === 'manual' ? '' : 'is-amber'}">${modeText}</span>
      <span class="chip">${this.activeScene === 'valve' ? 'Surgeon\'s view through the atriotomy' : `Heart model <b>${(this.heart.triangleCount / 1000).toFixed(0)}k</b> triangles`}</span>
      <span class="chip" id="perf-chip" title="Frame rate and rendering quality">--</span>
      ${this.sm.gpu.software ? '<span class="chip is-bad" title="Chrome is rendering with the CPU, not the graphics card. Enable hardware acceleration in Chrome settings for full speed.">Software rendering</span>' : ''}`;
    this.perfChip = this.layout.viewportStatus.querySelector('#perf-chip');
    this.perfText = '';
  }

  private perfChip: HTMLElement | null = null;
  private perfText = '';
  private fps = 60;
  private perfAccum = 0;
  private updatePerfChip(dt: number): void {
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    this.perfAccum += dt;
    if (this.perfAccum < 0.5 || !this.perfChip) return;
    this.perfAccum = 0;
    const q = this.sm.quality;
    const text = `<b>${Math.round(this.fps)}</b> fps · ${q.tier}${q.scale < 0.999 ? ` ${Math.round(q.scale * 100)}%` : ''}`;
    if (text === this.perfText) return;
    this.perfText = text;
    this.perfChip.innerHTML = text;
    this.perfChip.classList.toggle('is-bad', this.fps < 45);
    this.perfChip.classList.toggle('is-ok', this.fps >= 55);
  }

  // ------------------------------------------------------------------ procedures
  private renderProcedurePicker(): void {
    const p = this.layout.procedurePicker;
    p.innerHTML = '';
    for (const proc of PROCEDURES) {
      const b = el('button', `procedure-card ${this.procedure?.id === proc.id ? 'is-active' : ''}`);
      b.type = 'button';
      b.innerHTML = `<span class="pc-icon">${proc.icon}</span><span><span class="pc-name">${proc.name}</span><span class="pc-desc">${proc.short}</span></span>`;
      b.addEventListener('click', () => this.loadProcedure(proc));
      p.appendChild(b);
    }
  }

  private loadProcedure(proc: ProcedureDef): void {
    if (this.procedure?.id === proc.id) return;
    this.resetCase();
    this.procedure = proc;
    this.steps = proc.steps.map((def) => ({ def, task: null, actionDone: false, actionRunning: false, skipped: false }));
    this.layout.caseChip.innerHTML = `<b>${proc.name}</b><span>${proc.patient}</span>`;
    this.renderProcedurePicker();
    this.store.set({ procedureId: proc.id, stepIndex: 0, leftOpen: false });
    this.enterStep(0);
  }

  private resetCase(): void {
    const cur = this.currentStep();
    if (cur) { cur.task?.unmount(); cur.def.onExit?.(this.ctx); }
    this.overlays.clear();
    this.hint(null);
    for (const k of Object.keys(this.results)) delete this.results[k];
    this.ctx.data = {};
    this.phys = new Physiology();
    (this.vitals as unknown as { phys: Physiology }).phys = this.phys;
    this.ctx.phys = this.phys;
    if (this.graft) { this.sm.scene.remove(this.graft.group); this.graft = null; }
    this.valve.group.removeFromParent();
    this.valve = new MitralValve();
    this.valve.group.position.copy(this.heartCenter);
    this.valve.group.visible = false;
    this.sm.scene.add(this.valve.group);
    this.ctx.valve = this.valve;
    this.arms.right.show(false);
    this.arms.left.show(false);
    this.showScene('heart');
    this.labelFilter = null;
    this.updateLabels();
    this.steps = [];
    this.procedure = null;
    this.store.set({ taskActive: false });
  }

  private currentStep(): StepRuntime | null {
    return this.steps[this.store.state.stepIndex] ?? null;
  }

  private stepComplete(rt: StepRuntime): boolean {
    if (rt.skipped) return true;
    if (rt.def.task) return !!rt.task?.result;
    if (rt.def.action) return rt.actionDone;
    return true;
  }

  private async enterStep(index: number): Promise<void> {
    const rt = this.steps[index];
    if (!rt) return;
    this.store.set({ stepIndex: index, taskActive: false, view: 'step' });
    this.hint(null);
    if (rt.def.scene === 'valve' && this.activeScene !== 'valve') this.showScene('valve');
    if (rt.def.scene !== 'valve' && this.activeScene === 'valve' && rt.def.id === 'close') { /* handled by the action */ }
    // steps that name their landmarks show exactly those; other steps keep the field clean
    this.labelFilter = rt.def.labels ? ((id) => rt.def.labels!.includes(id)) : null;
    if (this.store.state.layers.labels !== !!rt.def.labels) this.store.set({ layers: { ...this.store.state.layers, labels: !!rt.def.labels } });
    this.updateLabels();
    await rt.def.onEnter?.(this.ctx);
    if (rt.def.task && !rt.task) {
      rt.task = rt.def.task(this.ctx);
    }
    if (rt.task) {
      rt.task.onChange = () => { if (rt.task?.result) this.results[rt.def.id] = rt.task.result; this.renderPanel(); this.renderSteps(); };
      rt.task.mount();
    }
    const pose = rt.def.pose?.(this.ctx);
    if (pose) {
      this.placePorts(pose);
      void this.sm.flyTo(pose, 1.4);
    }
    this.renderSteps();
    this.renderPanel();
    this.renderViewControls();
  }

  /** Instrument ports sit at the lower corners of the step's view, like a console picture. */
  private placePorts(pose: CameraPose): void {
    const dir = pose.target.clone().sub(pose.position).normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const dist = pose.position.distanceTo(pose.target);
    const back = pose.position.clone().addScaledVector(dir, dist * 0.15);
    this.arms.right.setPort(back.clone().addScaledVector(right, dist * 0.55).addScaledVector(up, -dist * 0.35));
    this.arms.left.setPort(back.clone().addScaledVector(right, -dist * 0.55).addScaledVector(up, -dist * 0.35));
  }

  private leaveStep(): void {
    const rt = this.currentStep();
    if (!rt) return;
    rt.task?.unmount();
    rt.def.onExit?.(this.ctx);
  }

  private goToStep(index: number): void {
    if (index < 0 || index >= this.steps.length) return;
    this.leaveStep();
    void this.enterStep(index);
  }

  private renderSteps(): void {
    const list = this.layout.steps;
    list.innerHTML = '';
    if (!this.procedure) {
      list.innerHTML = '<li class="steps-empty">Choose a procedure to load its operative plan. Each step that needs precision is measured and scored.</li>';
      return;
    }
    const cur = this.store.state.stepIndex;
    let firstIncomplete = this.steps.findIndex((s) => !this.stepComplete(s));
    if (firstIncomplete < 0) firstIncomplete = this.steps.length;
    this.steps.forEach((rt, i) => {
      const li = el('li');
      const b = el('button', 'step');
      b.type = 'button';
      const done = this.stepComplete(rt) && i !== cur;
      const locked = i > Math.max(cur, firstIncomplete);
      if (done) b.classList.add('is-done');
      if (i === cur) b.classList.add('is-current');
      if (locked) b.classList.add('is-locked');
      const res = this.results[rt.def.id];
      b.innerHTML = `<span class="st-num">${done ? icons.check : i + 1}</span><span><span class="st-title">${rt.def.title}</span><br><span class="st-meta">${rt.def.short}${res ? ` <span class="st-score">${res.score}</span>` : ''}</span></span>`;
      b.disabled = locked;
      b.addEventListener('click', () => this.goToStep(i));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ right panel
  private renderPanel(): void {
    const { panelHead, panelBody, panelFooter } = this.layout;
    const rt = this.currentStep();
    panelFooter.innerHTML = '';
    if (!rt || !this.procedure) {
      panelHead.innerHTML = `<div class="ph-index">Welcome</div><h2>Precision cardiac surgery, planned in 3D</h2>`;
      panelBody.innerHTML = `
        <p>Explore the patient's heart, then load one of the two procedures on the left. Every incision and suture is measured against the surgical plan so you can compare a human hand with robotic execution.</p>
        <div class="note"><b>Two procedures.</b> A robotic LIMA to LAD bypass, where the anastomosis is sewn on a 2 mm artery, and a mitral valve repair, where leaflet resection, neochordae and ring sizing all come down to a millimetre.</div>
        <p>Drag to orbit the heart, scroll to zoom. Turn on labels from the controls in the viewport.</p>`;
      return;
    }
    const idx = this.store.state.stepIndex;
    panelHead.innerHTML = `
      <div class="ph-index">Step ${idx + 1} of ${this.steps.length}</div>
      <h2>${rt.def.title}</h2>
      <div class="ph-instrument">${icons.scalpel}<span>${rt.def.instrument}</span></div>`;
    panelBody.innerHTML = '';
    for (const p of rt.def.description) panelBody.appendChild(el('p', undefined, p));
    if (rt.def.note) panelBody.appendChild(el('div', 'note', rt.def.note));
    if (rt.task) panelBody.appendChild(this.renderTaskCard(rt));
    if (rt.def.action) panelBody.appendChild(this.renderActionCard(rt));
    if (rt.task?.robotic) panelBody.appendChild(this.renderControlMode());

    const prev = el('button', 'btn is-ghost', 'Previous');
    prev.type = 'button';
    prev.disabled = idx === 0;
    prev.addEventListener('click', () => this.goToStep(idx - 1));
    panelFooter.appendChild(prev);
    const complete = this.stepComplete(rt);
    const last = idx === this.steps.length - 1;
    if (last) {
      const rep = el('button', 'btn is-primary is-block', `${icons.report}<span>Open case report</span>`);
      rep.type = 'button';
      rep.disabled = !complete;
      rep.addEventListener('click', () => this.openReport());
      panelFooter.appendChild(rep);
    } else {
      const next = el('button', `btn ${complete ? 'is-primary' : ''} is-block`, complete ? 'Next step' : 'Skip step');
      next.type = 'button';
      next.addEventListener('click', () => { if (!this.stepComplete(rt)) rt.skipped = true; this.goToStep(idx + 1); });
      panelFooter.appendChild(next);
    }
  }

  private renderTaskCard(rt: StepRuntime): HTMLElement {
    const task = rt.task!;
    const card = el('div', 'task');
    const phase = (task as unknown as { phase: string }).phase;
    const stateText = task.result ? `Score ${task.result.score}` : phase === 'armed' || phase === 'active' ? 'In progress' : phase === 'executing' ? 'Robot executing' : 'Ready';
    card.innerHTML = `<div class="task-head"><h3>${task.title}</h3><span class="task-state ${task.result ? 'is-ok' : phase === 'idle' ? '' : 'is-active'}">${stateText}</span></div>`;
    const body = el('div', 'task-body');
    body.appendChild(el('p', undefined, task.instructions));
    const controls = task.controls?.();
    if (controls) body.appendChild(controls);
    if (task.result) {
      body.appendChild(this.renderResult(task.result));
    }
    const actions = el('div', 'task-actions');
    const mode = this.store.state.controlMode;
    if (task.robotic) {
      if (!task.result) {
        if (mode !== 'autonomous') {
          const b = el('button', 'btn is-primary', `${icons.play}<span>${task.startLabel ?? 'Begin'}</span>`);
          b.type = 'button';
          b.disabled = phase === 'armed' || phase === 'active' || phase === 'executing';
          b.addEventListener('click', () => { task.begin(); this.renderPanel(); });
          actions.appendChild(b);
        }
        const r = el('button', `btn ${mode === 'autonomous' ? 'is-primary' : ''}`, `${icons.robot}<span>Execute with robot</span>`);
        r.type = 'button';
        r.disabled = phase === 'executing';
        r.addEventListener('click', () => { void task.execute(); this.renderPanel(); });
        actions.appendChild(r);
      }
      if (phase !== 'idle') {
        const reset = el('button', 'btn is-ghost', `${icons.reset}<span>${task.result ? 'Try again' : 'Cancel'}</span>`);
        reset.type = 'button';
        reset.addEventListener('click', () => { task.reset(); delete this.results[rt.def.id]; this.renderPanel(); this.renderSteps(); });
        actions.appendChild(reset);
      }
    } else if (task.result) {
      const reset = el('button', 'btn is-ghost', `${icons.reset}<span>Change answer</span>`);
      reset.type = 'button';
      reset.addEventListener('click', () => { task.reset(); delete this.results[rt.def.id]; this.renderPanel(); this.renderSteps(); });
      actions.appendChild(reset);
    }
    if (actions.childElementCount) body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  private renderResult(r: TaskResult): HTMLElement {
    const wrap = el('div', 'metrics');
    const g = grade(r.score);
    const circ = 2 * Math.PI * 26;
    wrap.innerHTML = `
      <div class="score-ring">
        <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="32" cy="32" r="26" fill="none" stroke="var(--${g.cls === 'ok' ? 'ok' : g.cls === 'warn' ? 'warn' : 'bad'})" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(circ * r.score) / 100} ${circ}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle" fill="var(--text)" font-size="16" font-family="var(--mono)">${r.score}</text></svg>
        <div><div class="sr-label"><span class="grade ${g.cls}">${g.label}</span></div><div class="sr-label" style="margin-top:4px">${MODE_LABELS[r.mode]}</div></div>
      </div>
      ${r.metrics.map((m) => `<div class="metric-row is-${m.status}"><span>${m.label}</span><b>${m.value}</b><small>${m.target ?? ''}</small></div>`).join('')}`;
    return wrap;
  }

  private renderActionCard(rt: StepRuntime): HTMLElement {
    const a = rt.def.action!;
    const card = el('div', 'task');
    card.innerHTML = `<div class="task-head"><h3>${rt.actionDone ? (a.doneLabel ?? 'Done') : a.label}</h3><span class="task-state ${rt.actionDone ? 'is-ok' : rt.actionRunning ? 'is-active' : ''}">${rt.actionDone ? 'Complete' : rt.actionRunning ? 'Running' : 'Ready'}</span></div>`;
    const body = el('div', 'task-body');
    const b = el('button', 'btn is-primary', `${icons.play}<span>${a.label}</span>`);
    b.type = 'button';
    b.disabled = rt.actionDone || rt.actionRunning;
    b.addEventListener('click', async () => {
      rt.actionRunning = true;
      this.renderPanel();
      try { await a.run(this.ctx); } finally { rt.actionRunning = false; rt.actionDone = true; }
      this.renderPanel();
      this.renderSteps();
      this.renderStatus();
    });
    body.appendChild(b);
    card.appendChild(body);
    return card;
  }

  private renderControlMode(): HTMLElement {
    const s = this.store.state;
    const wrap = el('div', 'control-mode');
    wrap.innerHTML = `
      <div class="control-mode-label"><span>Who holds the instrument</span></div>
      <div class="mode-seg" role="group" aria-label="Control mode">
        ${(['manual', 'assisted', 'autonomous'] as ControlMode[]).map((m) => `<button type="button" data-mode="${m}" class="${s.controlMode === m ? 'is-active' : ''}">${MODE_LABELS[m]}</button>`).join('')}
      </div>
      <div class="mode-desc">${MODE_DESCRIPTIONS[s.controlMode]}</div>
      ${s.controlMode === 'assisted' ? `
        <div class="slider-row"><span>Motion scaling</span><output>${s.motionScale}:1</output><input type="range" min="1" max="5" step="1" value="${s.motionScale}" aria-label="Motion scaling" data-scale /></div>
        <div class="toggle-row"><span>Tremor filter</span><button type="button" class="switch ${s.tremorFilter ? 'is-on' : ''}" role="switch" aria-checked="${s.tremorFilter}" aria-label="Tremor filter" data-tremor></button></div>` : ''}`;
    wrap.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => { this.store.set({ controlMode: b.dataset.mode as ControlMode }); this.renderPanel(); }));
    wrap.querySelector<HTMLInputElement>('[data-scale]')?.addEventListener('input', (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      this.store.set({ motionScale: v });
      wrap.querySelector('output')!.textContent = `${v}:1`;
    });
    wrap.querySelector<HTMLButtonElement>('[data-tremor]')?.addEventListener('click', () => { this.store.set({ tremorFilter: !this.store.state.tremorFilter }); this.renderPanel(); });
    return wrap;
  }

  // ------------------------------------------------------------------ pointer routing
  private bindPointer(): void {
    const canvas = this.sm.renderer.domElement;
    const route = (kind: 'down' | 'move' | 'up' | 'leave') => (e: PointerEvent) => {
      const task = this.currentStep()?.task;
      // while exploded the vessels are drawn away from their pickable geometry
      if (!task || this.store.state.exploded) return;
      const capture = task.pointer(kind, e);
      if (capture && !this.pointerCaptured) { this.pointerCaptured = true; this.sm.controls.enabled = false; try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } }
      if (!capture && this.pointerCaptured) { this.pointerCaptured = false; this.sm.controls.enabled = true; try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    };
    canvas.addEventListener('pointerdown', route('down'));
    canvas.addEventListener('pointermove', route('move'));
    canvas.addEventListener('pointerup', route('up'));
    canvas.addEventListener('pointerleave', route('leave'));
    // In assisted/manual modes the orbit controls must not fight the cut: while a task is armed,
    // a drag that starts on the model is a surgical action, so disable rotation on the start marker.
    canvas.addEventListener('pointerdown', (e) => {
      const task = this.currentStep()?.task;
      if (!task || !this.store.state.taskActive) return;
      if (this.pointerCaptured) e.preventDefault();
    });
  }

  // ------------------------------------------------------------------ modals
  private openModal(html: string): void {
    this.layout.modal.innerHTML = html;
    this.layout.modalBackdrop.classList.add('is-open');
    this.layout.modal.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => this.closeModal()));
  }

  private closeModal(): void { this.layout.modalBackdrop.classList.remove('is-open'); }

  private openReport(): void {
    const proc = this.procedure;
    const v = this.phys.vitals();
    if (!proc) {
      this.openModal(`<div class="modal-head"><div><h2>Case report</h2><p>No case loaded yet.</p></div><button class="icon-btn" data-close aria-label="Close">${icons.close}</button></div><div class="modal-body"><p>Select a procedure and complete its measured steps to generate a report.</p></div><div class="modal-foot"><button class="btn" data-close>Close</button></div>`);
      return;
    }
    const scored = this.steps.filter((s) => this.results[s.def.id]);
    const overall = scored.length ? Math.round(scored.reduce((a, s) => a + this.results[s.def.id].score, 0) / scored.length) : 0;
    const precisionSteps = scored.filter((s) => this.results[s.def.id].raw && ('meanDeviationMm' in this.results[s.def.id].raw! || 'meanErrorMm' in this.results[s.def.id].raw!));
    const meanMm = precisionSteps.length ? precisionSteps.reduce((a, s) => { const r = this.results[s.def.id].raw!; return a + (r.meanDeviationMm ?? r.meanErrorMm ?? 0); }, 0) / precisionSteps.length : 0;
    const g = grade(overall);
    const rows = this.steps.map((s, i) => {
      const r = this.results[s.def.id];
      if (!r) return `<tr><td>${i + 1}</td><td>${s.def.title}</td><td colspan="2" style="color:var(--text-faint)">${s.skipped ? 'Skipped' : s.def.task ? 'Not attempted' : s.actionDone ? 'Completed' : 'Pending'}</td><td class="num"></td></tr>`;
      const gg = grade(r.score);
      return `<tr><td>${i + 1}</td><td><b>${s.def.title}</b><br><span style="font-size:12px">${r.summary}</span></td><td>${MODE_LABELS[r.mode]}</td><td><span class="grade ${gg.cls}">${gg.label}</span></td><td class="num">${r.score}</td></tr>`;
    }).join('');
    const flow = this.ctx.data.flow as { mean: number; pi: string; df: number } | undefined;
    const saline = this.ctx.data.saline as { gap: number; leak: boolean } | undefined;
    const outcome = flow
      ? `Graft flow ${flow.mean} mL/min, PI ${flow.pi}, diastolic filling ${flow.df}%.`
      : saline
        ? (saline.leak ? `Residual regurgitation on saline test (gap ${(saline.gap * 10).toFixed(1)} mm).` : 'Competent valve on saline test, no residual regurgitation.')
        : 'Outcome pending.';
    const json = JSON.stringify({
      procedure: proc.name, patient: proc.patient, indication: proc.indication, generated: new Date().toISOString(),
      overallScore: overall, crossClampSeconds: Math.round(v.clampSeconds), bypassSeconds: Math.round(v.bypassSeconds),
      steps: this.steps.map((s) => ({ id: s.def.id, title: s.def.title, result: this.results[s.def.id] ?? null, skipped: s.skipped })),
      outcome, data: { flow: flow ?? null, saline: saline ?? null, ringSize: this.ctx.data.ringSize ?? null, measurements: this.ctx.data.measurements ?? null },
    }, null, 2);
    const href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    this.openModal(`
      <div class="modal-head"><div><h2>Case report</h2><p>${proc.name}. ${proc.patient}.</p></div><button class="icon-btn" data-close aria-label="Close">${icons.close}</button></div>
      <div class="modal-body">
        <div class="report-grid">
          <div class="report-stat"><small>Overall precision</small><b style="color:var(--${g.cls === 'ok' ? 'ok' : g.cls === 'warn' ? 'warn' : 'bad'})">${overall}</b><small>${g.label}</small></div>
          <div class="report-stat"><small>Mean deviation from plan</small><b>${precisionSteps.length ? meanMm.toFixed(2) + ' mm' : '--'}</b><small>across ${precisionSteps.length} measured steps</small></div>
          <div class="report-stat"><small>Cross-clamp time</small><b>${formatClock(v.clampSeconds)}</b><small>bypass ${formatClock(v.bypassSeconds)}</small></div>
        </div>
        <p style="color:var(--text-dim);font-size:13px">${outcome}</p>
        <div style="overflow:auto"><table class="report-table"><thead><tr><th>#</th><th>Step</th><th>Control</th><th>Grade</th><th style="text-align:right">Score</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="note">Scores compare each cut, stitch and measurement with the surgical plan. Robotic execution removes tremor and scales motion; the same plan executed autonomously typically lands within a few hundredths of a millimetre.</div>
      </div>
      <div class="modal-foot"><a class="btn" download="roboclaw-${proc.id}-report.json" href="${href}">${icons.download}<span>Download JSON</span></a><button class="btn is-primary" data-close>Close</button></div>`);
  }

  private openSettings(): void {
    const s = this.store.state;
    this.openModal(`
      <div class="modal-head"><div><h2>Settings</h2><p>Simulation and display options.</p></div><button class="icon-btn" data-close aria-label="Close">${icons.close}</button></div>
      <div class="modal-body settings-grid">
        <div class="row"><div><b>Default control mode</b><p>Used when a precision task starts.</p></div>
          <select id="set-mode">${(['manual', 'assisted', 'autonomous'] as ControlMode[]).map((m) => `<option value="${m}" ${s.controlMode === m ? 'selected' : ''}>${MODE_LABELS[m]}</option>`).join('')}</select></div>
        <div class="row"><div><b>Graphics quality</b><p>Automatic holds 60 fps by adjusting resolution and shading. ${this.sm.gpu.software ? 'This browser is rendering on the CPU, so even Low will be slow: turn on hardware acceleration in Chrome settings.' : `Detected: ${this.sm.gpu.renderer.slice(0, 60)}`}</p></div>
          <select id="set-quality">
            <option value="auto" ${this.sm.quality.auto ? 'selected' : ''}>Automatic</option>
            ${(['ultra', 'high', 'medium', 'low'] as QualityTier[]).map((t) => `<option value="${t}" ${!this.sm.quality.auto && this.sm.quality.tier === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select></div>
        <div class="row"><div><b>Reset the case</b><p>Clears all results and restarts the selected procedure.</p></div><button type="button" class="btn is-danger" id="set-reset">Reset case</button></div>
        <div class="row"><div><b>About</b><p>RoboClaw Cardiac generates the anatomy procedurally from a signed distance model at 1 mm resolution. Measurements are in millimetres of the modelled heart, roughly 13 cm long.</p></div></div>
      </div>
      <div class="modal-foot"><button class="btn is-primary" data-close>Done</button></div>`);
    const modal = this.layout.modal;
    modal.querySelector<HTMLSelectElement>('#set-mode')!.addEventListener('change', (e) => { this.store.set({ controlMode: (e.target as HTMLSelectElement).value as ControlMode }); this.renderPanel(); });
    modal.querySelector<HTMLSelectElement>('#set-quality')!.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === 'auto') { this.sm.quality.auto = true; this.sm.quality.apply(); }
      else this.sm.quality.setTier(v as QualityTier, false);
      this.renderStatus();
    });
    modal.querySelector<HTMLButtonElement>('#set-reset')!.addEventListener('click', () => {
      const proc = this.procedure;
      this.closeModal();
      this.resetCase();
      this.renderProcedurePicker();
      this.renderSteps();
      this.renderPanel();
      this.layout.caseChip.innerHTML = `<b>No case loaded</b><span>Select a procedure to begin</span>`;
      if (proc) this.loadProcedure(proc);
    });
  }
}

export type { Metric };
