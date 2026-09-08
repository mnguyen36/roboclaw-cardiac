/**
 * Simulated patient physiology: rhythm, haemodynamics, temperature, bypass and clamp timers.
 * Drives the vitals monitor and the heart's contraction uniform.
 */
import { contractionAt, ecgAt, abpAt } from '../scene/heartbeat';

export type Rhythm = 'sinus' | 'fibrillation' | 'asystole';

export interface Vitals {
  hr: number;
  sys: number;
  dia: number;
  map: number;
  spo2: number;
  temp: number;
  rhythm: Rhythm;
  onBypass: boolean;
  cpbFlow: number;
  crossClamped: boolean;
  clampSeconds: number;
  bypassSeconds: number;
}

export class Physiology {
  hr = 72;
  sys = 118;
  dia = 76;
  spo2 = 98;
  temp = 36.6;
  rhythm: Rhythm = 'sinus';
  onBypass = false;
  cpbFlow = 0;
  crossClamped = false;
  clampSeconds = 0;
  bypassSeconds = 0;
  /** Cardiac cycle phase, 0 at the R wave. */
  phase = 0;
  /** Contraction strength for the tissue shader. */
  contraction = 0;
  private vigor = 1;
  private targetTemp = 36.6;
  private time = 0;
  private listeners = new Set<() => void>();
  private slowNoise = 0;

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() { for (const l of this.listeners) l(); }

  update(dt: number): void {
    this.time += dt;
    if (this.rhythm === 'sinus') {
      this.phase += dt * (this.hr / 60);
      const target = this.onBypass ? 0.15 : 1;
      this.vigor += (target - this.vigor) * Math.min(1, dt * 1.5);
      this.contraction = contractionAt(this.phase) * this.vigor;
    } else if (this.rhythm === 'fibrillation') {
      this.vigor += (0 - this.vigor) * Math.min(1, dt * 1.2);
      this.contraction = 0.05 * this.vigor + 0.02 * Math.sin(this.time * 41) * Math.sin(this.time * 23 + 1);
    } else {
      this.vigor += (0 - this.vigor) * Math.min(1, dt * 2);
      this.contraction = this.vigor * 0.1;
    }
    // temperature drifts towards target (cooling/rewarming on bypass)
    this.temp += (this.targetTemp - this.temp) * Math.min(1, dt * 0.08);
    if (this.crossClamped) this.clampSeconds += dt;
    if (this.onBypass) this.bypassSeconds += dt;
    // small haemodynamic variation
    this.slowNoise = Math.sin(this.time * 0.37) * 0.5 + Math.sin(this.time * 0.11) * 0.5;
  }

  /** ECG amplitude in mV at the current instant, with optional sub-step offset in seconds. */
  ecg(offsetSeconds = 0): number {
    if (this.rhythm === 'sinus') {
      const p = this.phase + offsetSeconds * (this.hr / 60);
      return ecgAt(p) + (Math.random() - 0.5) * 0.015;
    }
    if (this.rhythm === 'fibrillation') {
      const t = this.time + offsetSeconds;
      return 0.22 * Math.sin(t * 38 + Math.sin(t * 7) * 3) * (0.6 + 0.4 * Math.sin(t * 5.3)) + (Math.random() - 0.5) * 0.12;
    }
    return (Math.random() - 0.5) * 0.02;
  }

  /** Arterial pressure in mmHg at the current instant. */
  abp(offsetSeconds = 0): number {
    if (this.onBypass) {
      // non-pulsatile roller pump flow with slight ripple
      const base = 62 + this.slowNoise * 2;
      return base + Math.sin((this.time + offsetSeconds) * 20) * 1.2;
    }
    if (this.rhythm === 'sinus') {
      const p = this.phase + offsetSeconds * (this.hr / 60);
      return abpAt(p, this.sys + this.slowNoise * 2, this.dia + this.slowNoise);
    }
    if (this.rhythm === 'fibrillation') return 28 + Math.random() * 4;
    return 6 + Math.random();
  }

  vitals(): Vitals {
    const pulsatile = this.rhythm === 'sinus' && !this.onBypass;
    const sys = pulsatile ? Math.round(this.sys + this.slowNoise * 2) : this.onBypass ? 0 : 0;
    const dia = pulsatile ? Math.round(this.dia + this.slowNoise) : 0;
    const map = this.onBypass ? Math.round(62 + this.slowNoise * 2) : pulsatile ? Math.round((sys + 2 * dia) / 3) : this.rhythm === 'fibrillation' ? 30 : 6;
    return {
      hr: this.rhythm === 'sinus' ? Math.round(this.hr + this.slowNoise) : 0,
      sys, dia, map,
      spo2: Math.round(this.spo2),
      temp: this.temp,
      rhythm: this.rhythm,
      onBypass: this.onBypass,
      cpbFlow: this.cpbFlow,
      crossClamped: this.crossClamped,
      clampSeconds: this.clampSeconds,
      bypassSeconds: this.bypassSeconds,
    };
  }

  /** Start cardiopulmonary bypass: full flow, cooling to mild hypothermia. */
  startBypass(): void {
    this.onBypass = true;
    this.cpbFlow = 4.8;
    this.targetTemp = 32;
    this.spo2 = 99;
    this.emit();
  }

  /** Cross-clamp the aorta and deliver cardioplegia: brief fibrillation then diastolic arrest. */
  async arrest(): Promise<void> {
    this.crossClamped = true;
    this.rhythm = 'fibrillation';
    this.emit();
    await wait(2600);
    this.rhythm = 'asystole';
    this.emit();
  }

  /** Release the clamp, rewarm, defibrillate and return to sinus rhythm. */
  async reperfuse(): Promise<void> {
    this.crossClamped = false;
    this.targetTemp = 36.6;
    this.rhythm = 'fibrillation';
    this.emit();
    await wait(3200);
    this.rhythm = 'sinus';
    this.phase = 0;
    this.hr = 84;
    this.emit();
  }

  /** Wean from bypass over a few seconds. */
  async wean(): Promise<void> {
    const steps = [3.5, 2.5, 1.5, 0.8, 0];
    for (const f of steps) {
      this.cpbFlow = f;
      this.emit();
      await wait(700);
    }
    this.onBypass = false;
    this.cpbFlow = 0;
    this.sys = 112;
    this.dia = 70;
    this.emit();
    await wait(1500);
    this.hr = 78;
    this.emit();
  }
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}
