/** Builds the application shell and returns references to the live regions. */
import { icons, brandMark } from './icons';

export interface Layout {
  root: HTMLElement;
  viewport: HTMLElement;
  loading: HTMLElement;
  loadingText: HTMLElement;
  loadingBar: HTMLElement;
  caseChip: HTMLElement;
  phasePill: HTMLElement;
  clock: HTMLElement;
  clockValue: HTMLElement;
  btnReport: HTMLButtonElement;
  btnSettings: HTMLButtonElement;
  btnLeft: HTMLButtonElement;
  btnRight: HTMLButtonElement;
  procedurePicker: HTMLElement;
  steps: HTMLElement;
  panelHead: HTMLElement;
  panelBody: HTMLElement;
  panelFooter: HTMLElement;
  viewControls: HTMLElement;
  viewportStatus: HTMLElement;
  hint: HTMLElement;
  liveMetrics: HTMLElement;
  vitalsCanvas: HTMLCanvasElement;
  vitalsNumbers: HTMLElement;
  modalBackdrop: HTMLElement;
  modal: HTMLElement;
}

export function buildLayout(root: HTMLElement): Layout {
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn only-narrow" id="btn-left" title="Procedure steps" aria-label="Open procedure steps">${icons.menu}</button>
      <div class="brand">${brandMark}<span class="brand-name">Robo<span>Claw</span></span><span class="brand-sub">Cardiac surgical suite</span></div>
      <div class="topbar-case" id="case-chip"><b>No case loaded</b><span>Select a procedure to begin</span></div>
      <div class="topbar-spacer"></div>
      <div class="phase-pill is-live" id="phase-pill"><i></i><span>Sinus rhythm</span></div>
      <div class="clock" id="clock"><span>Cross-clamp</span><b id="clock-value">00:00:00</b></div>
      <button class="icon-btn" id="btn-report" title="Case report">${icons.report}<span>Report</span></button>
      <button class="icon-btn" id="btn-settings" title="Settings" aria-label="Settings">${icons.settings}</button>
      <button class="icon-btn only-narrow" id="btn-right" title="Step details" aria-label="Open step details">${icons.panel}</button>
    </header>
    <aside class="rail-left" id="rail-left">
      <div class="rail-section-title">Procedure</div>
      <div class="procedure-picker" id="procedure-picker"></div>
      <div class="rail-section-title">Operative steps</div>
      <ol class="steps" id="steps"><li class="steps-empty">Choose a procedure to load its operative plan. Each step that needs precision is measured and scored.</li></ol>
    </aside>
    <main class="viewport" id="viewport">
      <div class="loading" id="loading">
        <div class="loading-inner">
          <svg class="loading-ecg" viewBox="0 0 220 44" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M0 26h40l6-10 8 24 8-32 8 22 6-4h30l6-10 8 24 8-32 8 22 6-4h40l6-10 8 24 8-32 8 22 6-4h40"/></svg>
          <h2>Generating patient anatomy</h2>
          <p id="loading-text">Preparing</p>
          <div class="loading-bar"><i id="loading-bar"></i></div>
        </div>
      </div>
      <div class="view-controls" id="view-controls"></div>
      <div class="viewport-hint" id="hint"></div>
      <div class="live-metrics" id="live-metrics"></div>
      <div class="viewport-status" id="viewport-status"></div>
    </main>
    <aside class="rail-right" id="rail-right">
      <div class="panel-head" id="panel-head">
        <div class="ph-index">Welcome</div>
        <h2>Precision cardiac surgery, planned in 3D</h2>
      </div>
      <div class="panel-body" id="panel-body">
        <p>Explore the patient's heart, then load one of the two procedures on the left. Every incision and suture is measured against the surgical plan so you can compare a human hand with robotic execution.</p>
      </div>
      <div class="panel-footer" id="panel-footer"></div>
    </aside>
    <footer class="vitals">
      <div class="vitals-trace"><canvas id="vitals-canvas"></canvas><span class="trace-label">ECG II</span><span class="trace-label abp">ABP</span></div>
      <div class="vitals-numbers" id="vitals-numbers"></div>
    </footer>
    <div class="modal-backdrop" id="modal-backdrop"><div class="modal" id="modal" role="dialog" aria-modal="true"></div></div>
  `;
  const q = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  return {
    root,
    viewport: q('viewport'),
    loading: q('loading'),
    loadingText: q('loading-text'),
    loadingBar: q('loading-bar'),
    caseChip: q('case-chip'),
    phasePill: q('phase-pill'),
    clock: q('clock'),
    clockValue: q('clock-value'),
    btnReport: q<HTMLButtonElement>('btn-report'),
    btnSettings: q<HTMLButtonElement>('btn-settings'),
    btnLeft: q<HTMLButtonElement>('btn-left'),
    btnRight: q<HTMLButtonElement>('btn-right'),
    procedurePicker: q('procedure-picker'),
    steps: q('steps'),
    panelHead: q('panel-head'),
    panelBody: q('panel-body'),
    panelFooter: q('panel-footer'),
    viewControls: q('view-controls'),
    viewportStatus: q('viewport-status'),
    hint: q('hint'),
    liveMetrics: q('live-metrics'),
    vitalsCanvas: q<HTMLCanvasElement>('vitals-canvas'),
    vitalsNumbers: q('vitals-numbers'),
    modalBackdrop: q('modal-backdrop'),
    modal: q('modal'),
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
