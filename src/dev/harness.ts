/**
 * Development harness: deterministic frame stepping and synthetic pointer input so the
 * procedures can be exercised from the console (or automated tests) even in a hidden tab.
 * Loaded only in development when the page is opened with `?harness`.
 */
import * as THREE from 'three';
import type { App } from '../app/App';

export function installHarness(app: App): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = app as unknown as Record<string, any>;
  const w = window as unknown as Record<string, unknown>;
  a.sm.renderer.setPixelRatio(1);
  a.sm.resize();

  const render = () => {
    a.sm.renderer.render(a.sm.scene, a.sm.camera);
    a.sm.labelRenderer.render(a.sm.scene, a.sm.camera);
  };
  const advance = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      a.sm.updateTween(dt);
      a.sm.controls.update();
      for (const cb of a.sm.callbacks) cb(dt, i * dt);
    }
  };
  const step = (n: number, dt = 1 / 60) => { advance(n, dt); render(); };
  const proj = (v: THREE.Vector3) => {
    a.sm.camera.updateMatrixWorld();
    const p = v.clone().project(a.sm.camera);
    const r = a.sm.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  };
  const ptr = (type: string, x: number, y: number) => {
    // orbit controls cannot capture a synthetic pointer; keep them out of the way
    const prev = a.sm.controls.enabled;
    a.sm.controls.enabled = false;
    a.sm.renderer.domElement.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, bubbles: true, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    if (!a.pointerCaptured) a.sm.controls.enabled = prev;
  };
  const clickAt = (v: THREE.Vector3) => {
    const s = proj(v);
    ptr('pointerdown', s.x, s.y);
    advance(2);
    ptr('pointerup', s.x, s.y);
    advance(2);
  };
  const drag = (points: THREE.Vector3[], framesPerPoint = 2) => {
    const s0 = proj(points[0]);
    ptr('pointerdown', s0.x, s0.y);
    advance(framesPerPoint);
    for (let i = 1; i < points.length; i++) {
      const s = proj(points[i]);
      ptr('pointermove', s.x, s.y);
      advance(framesPerPoint);
    }
    const sl = proj(points[points.length - 1]);
    ptr('pointerup', sl.x, sl.y);
    advance(2);
  };
  const next = () => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('#panel-footer button')].find((x) => /Next step|Skip step/.test(x.textContent ?? ''));
    b?.click();
  };
  const action = () => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('.task .btn.is-primary')].find((x) => !x.disabled);
    b?.click();
    return b?.textContent ?? null;
  };
  const load = (id: string) => {
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.procedure-card')];
    cards[id === 'cabg' ? 0 : 1]?.click();
  };
  const fit = (width: number, height: number) => {
    const el = document.getElementById('app')!;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  };
  /** Wait until a predicate holds, advancing frames without rendering. */
  const until = async (pred: () => boolean, maxMs = 20000) => {
    const t0 = performance.now();
    while (!pred() && performance.now() - t0 < maxMs) {
      advance(6);
      await new Promise((r) => setTimeout(r, 30));
    }
    return pred();
  };
  Object.assign(w, {
    __app: app, __step: step, __advance: advance, __render: render, __proj: proj, __ptr: ptr, __clickAt: clickAt, __drag: drag,
    __next: next, __action: action, __load: load, __fit: fit, __until: until, __THREE: THREE,
  });
  console.info('[harness] installed');
}
