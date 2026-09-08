/**
 * Patient monitor strip: sweeping ECG and arterial pressure traces plus numeric vitals.
 */
import type { Physiology } from '../app/physiology';
import { formatClock } from '../app/physiology';

const SAMPLE_RATE = 200;

export class VitalsMonitor {
  private ctx: CanvasRenderingContext2D;
  private ecg: Float32Array;
  private abp: Float32Array;
  private head = 0;
  private acc = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lastNumbers = '';

  constructor(private canvas: HTMLCanvasElement, private numbers: HTMLElement, private phys: Physiology) {
    this.ctx = canvas.getContext('2d')!;
    this.ecg = new Float32Array(1);
    this.abp = new Float32Array(1);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement!);
    this.resize();
    this.numbers.innerHTML = `
      <div class="vital hr"><small>HR<span>bpm</span></small><b id="v-hr">--</b></div>
      <div class="vital abp"><small>ABP<span>mmHg</span></small><b id="v-abp">--/--</b></div>
      <div class="vital spo2"><small>SpO₂<span>%</span></small><b id="v-spo2">--</b></div>
      <div class="vital temp"><small>Temp<span>°C</span></small><b id="v-temp">--</b></div>
      <div class="vital cpb is-off"><small>CPB flow<span>L/min</span></small><b id="v-cpb">off</b></div>
    `;
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, parent.clientWidth);
    this.height = Math.max(1, parent.clientHeight);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    // 6 seconds of trace across the width
    const n = Math.max(2, Math.round(6 * SAMPLE_RATE));
    if (this.ecg.length !== n) {
      this.ecg = new Float32Array(n);
      this.abp = new Float32Array(n).fill(80);
      this.head = 0;
    }
  }

  update(dt: number): void {
    this.acc += dt;
    const step = 1 / SAMPLE_RATE;
    let guard = 0;
    while (this.acc >= step && guard++ < 400) {
      this.acc -= step;
      this.ecg[this.head] = this.phys.ecg(-this.acc);
      this.abp[this.head] = this.phys.abp(-this.acc);
      this.head = (this.head + 1) % this.ecg.length;
    }
    this.draw();
    this.updateNumbers();
  }

  private draw(): void {
    const { ctx, width: w, height: h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // faint grid
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += 25) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y < h; y += 25) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    const n = this.ecg.length;
    const px = w / n;
    const drawTrace = (buf: Float32Array, y0: number, yh: number, min: number, max: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        // sweep: the newest sample sits just left of the eraser bar
        const gap = 18;
        const rel = (i - this.head + n) % n;
        if (rel > n - gap) { started = false; continue; }
        const x = i * px;
        const v = (buf[i] - min) / (max - min);
        const y = y0 + yh - Math.min(1, Math.max(0, v)) * yh;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    const half = h / 2;
    drawTrace(this.ecg, 6, half - 10, -0.5, 1.4, '#3ad07f');
    drawTrace(this.abp, half + 6, half - 12, 0, 160, '#ff5563');
    // eraser bar position marker
    const hx = (this.head % n) * px;
    ctx.fillStyle = 'rgba(8,14,17,0.9)';
    ctx.fillRect(hx, 0, 4, h);
  }

  private updateNumbers(): void {
    const v = this.phys.vitals();
    const key = `${v.hr}|${v.sys}|${v.dia}|${v.map}|${v.spo2}|${v.temp.toFixed(1)}|${v.cpbFlow}|${v.rhythm}|${v.onBypass}`;
    if (key === this.lastNumbers) return;
    this.lastNumbers = key;
    const set = (id: string, html: string) => { const e = this.numbers.querySelector<HTMLElement>(`#${id}`); if (e) e.innerHTML = html; };
    set('v-hr', v.rhythm === 'sinus' ? `${v.hr}` : v.rhythm === 'fibrillation' ? 'VF' : '---');
    set('v-abp', v.onBypass ? `<em>mean</em>${v.map}` : v.rhythm === 'sinus' ? `${v.sys}/${v.dia}<em>(${v.map})</em>` : `<em>mean</em>${v.map}`);
    set('v-spo2', `${v.spo2}`);
    set('v-temp', v.temp.toFixed(1));
    set('v-cpb', v.onBypass ? v.cpbFlow.toFixed(1) : 'off');
    const cpbEl = this.numbers.querySelector('.vital.cpb');
    cpbEl?.classList.toggle('is-off', !v.onBypass);
    const hrEl = this.numbers.querySelector('.vital.hr');
    hrEl?.classList.toggle('is-off', v.rhythm !== 'sinus');
  }

  static clock(seconds: number): string { return formatClock(seconds); }
}
