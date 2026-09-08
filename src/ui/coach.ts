/**
 * Next-action guidance.
 *
 * At any moment exactly one control is the sensible thing to touch next. The coach marks
 * that control with a soft ring and a short caption, and moves as the case progresses.
 * It is deliberately quiet: one cue at a time, no modal tour, no blocking, and it can be
 * dismissed for good.
 */

export interface Cue {
  /** Element to point at. */
  target: HTMLElement | null;
  /** Short imperative caption, a few words. */
  text: string;
  /** Preferred caption side; falls back automatically when there is no room. */
  side?: 'below' | 'above' | 'right';
}

const STORAGE_KEY = 'roboclaw.coach.dismissed';

export class Coach {
  private ring: HTMLElement;
  private tip: HTMLElement;
  private current: HTMLElement | null = null;
  private visible = false;
  private dismissed = false;
  private timer = 0;
  /** Fired when the user dismisses guidance, so the settings toggle can update. */
  onDismissedChange: (() => void) | null = null;

  constructor(private root: HTMLElement) {
    try { this.dismissed = localStorage.getItem(STORAGE_KEY) === '1'; } catch { this.dismissed = false; }

    this.ring = document.createElement('div');
    this.ring.className = 'coach-ring';
    this.ring.setAttribute('aria-hidden', 'true');

    this.tip = document.createElement('div');
    this.tip.className = 'coach-tip';
    // announced politely: the cue is advisory, never a blocking dialog
    this.tip.setAttribute('role', 'status');
    this.tip.setAttribute('aria-live', 'polite');

    root.appendChild(this.ring);
    root.appendChild(this.tip);

    const reposition = () => { if (this.visible) this.place(); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    // A panel re-render can leave the target briefly unmeasurable, which hides the cue.
    // This low-rate tick lets it recover on its own instead of waiting for another render.
    this.timer = window.setInterval(reposition, 400);
  }

  get isDismissed(): boolean { return this.dismissed; }

  setDismissed(v: boolean): void {
    this.dismissed = v;
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* private mode */ }
    if (v) this.hide();
    this.onDismissedChange?.();
  }

  /** Point at a control, or pass a null target to clear. */
  show(cue: Cue): void {
    if (this.dismissed || !cue.target || !cue.target.isConnected) { this.hide(); return; }
    const changed = this.current !== cue.target;
    this.current = cue.target;
    this.side = cue.side ?? 'below';
    // Pointing at something below the fold helps nobody, so bring it into view — but only
    // when the cue moves, otherwise the repositioning tick would fight the user's scrolling.
    if (changed) {
      const r = cue.target.getBoundingClientRect();
      if (r.height > 0 && (r.top < 0 || r.bottom > window.innerHeight)) {
        cue.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    if (this.tip.dataset.text !== cue.text) {
      this.tip.dataset.text = cue.text;
      this.tip.innerHTML = '';
      const label = document.createElement('span');
      label.textContent = cue.text;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'coach-dismiss';
      close.textContent = '✕';
      close.title = 'Turn off these hints';
      close.setAttribute('aria-label', 'Turn off guidance hints');
      close.addEventListener('click', (e) => { e.stopPropagation(); this.setDismissed(true); });
      this.tip.append(label, close);
    }
    this.visible = true;
    this.ring.classList.add('is-visible');
    this.tip.classList.add('is-visible');
    this.place();
  }

  hide(): void {
    this.visible = false;
    this.current = null;
    this.ring.classList.remove('is-visible');
    this.tip.classList.remove('is-visible');
  }

  dispose(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private side: 'below' | 'above' | 'right' = 'below';

  private place(): void {
    const el = this.current;
    if (!el || !el.isConnected) { this.hide(); return; }
    const r = el.getBoundingClientRect();
    // a control scrolled out of its panel should not be pointed at
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) {
      this.ring.classList.remove('is-visible');
      this.tip.classList.remove('is-visible');
      return;
    }
    this.ring.classList.add('is-visible');
    this.tip.classList.add('is-visible');
    const pad = 4;
    this.ring.style.left = `${r.left - pad}px`;
    this.ring.style.top = `${r.top - pad}px`;
    this.ring.style.width = `${r.width + pad * 2}px`;
    this.ring.style.height = `${r.height + pad * 2}px`;

    const tipRect = this.tip.getBoundingClientRect();
    let top: number;
    let left = r.left;
    if (this.side === 'right') {
      top = r.top + r.height / 2 - tipRect.height / 2;
      left = r.right + 12;
    } else if (this.side === 'above' || r.bottom + tipRect.height + 14 > window.innerHeight) {
      top = r.top - tipRect.height - 10;
    } else {
      top = r.bottom + 10;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - tipRect.height - 8));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${top}px`;
  }
}
