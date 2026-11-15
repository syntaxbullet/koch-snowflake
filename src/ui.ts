import type { Key, Settings } from './settings';

/** Tiny declarative control builder. No framework, no virtual DOM. */
export class Panel {
  private syncers: Array<() => void> = [];

  constructor(
    private root: HTMLElement,
    private s: Settings,
    private onChange: (k: Key) => void,
  ) {}

  /** Re-read all controls from settings (after presets, playback, hash load). */
  sync() {
    for (const f of this.syncers) f();
  }

  section(title: string, open = true): HTMLElement {
    const d = document.createElement('details');
    d.className = 'section';
    d.open = open;
    d.innerHTML = `<summary>${title}</summary>`;
    const body = document.createElement('div');
    body.className = 'body';
    d.append(body);
    this.root.append(d);
    return body;
  }

  private row(parent: HTMLElement, label: string, hint?: string) {
    const r = document.createElement('label');
    r.className = 'row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    if (hint) r.title = hint;
    r.append(l);
    parent.append(r);
    return r;
  }

  slider(
    parent: HTMLElement,
    label: string,
    key: Key,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string = (v) => String(+v.toFixed(2)),
    hint?: string,
  ) {
    const r = this.row(parent, label, hint);
    r.classList.add('slider');
    const out = document.createElement('output');
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    const paint = () => {
      const v = this.s[key] as number;
      inp.value = String(v);
      out.textContent = fmt(v);
      const p = ((v - +inp.min) / (+inp.max - +inp.min)) * 100;
      inp.style.setProperty('--p', `${Math.max(0, Math.min(100, p))}%`);
    };
    inp.addEventListener('input', () => {
      (this.s[key] as number) = +inp.value;
      paint();
      this.onChange(key);
    });
    // double-click label to type an exact value
    out.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const v = prompt(label, String(this.s[key]));
      if (v != null && Number.isFinite(+v)) {
        (this.s[key] as number) = Math.min(+inp.max, Math.max(+inp.min, +v));
        paint();
        this.onChange(key);
      }
    });
    r.append(out, inp);
    this.syncers.push(paint);
    paint();
    return {
      setRange: (lo: number, hi: number) => {
        inp.min = String(lo);
        inp.max = String(hi);
        paint();
      },
      el: r,
    };
  }

  toggle(parent: HTMLElement, label: string, key: Key, hint?: string) {
    const r = this.row(parent, label, hint);
    r.classList.add('toggle');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.role = 'switch';
    inp.addEventListener('change', () => {
      (this.s[key] as boolean) = inp.checked;
      this.onChange(key);
    });
    r.append(inp);
    this.syncers.push(() => (inp.checked = this.s[key] as boolean));
    inp.checked = this.s[key] as boolean;
    return r;
  }

  color(parent: HTMLElement, label: string, key: Key) {
    const r = this.row(parent, label);
    r.classList.add('color');
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.addEventListener('input', () => {
      (this.s[key] as string) = inp.value;
      this.onChange(key);
    });
    r.append(inp);
    this.syncers.push(() => (inp.value = this.s[key] as string));
    inp.value = this.s[key] as string;
    return r;
  }

  segmented(parent: HTMLElement, label: string, key: Key, options: string[]) {
    const r = document.createElement('div');
    r.className = 'row seg-row';
    r.innerHTML = `<span class="label">${label}</span>`;
    const g = document.createElement('div');
    g.className = 'seg';
    const btns = options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o;
      b.addEventListener('click', () => {
        (this.s[key] as number) = i;
        paint();
        this.onChange(key);
      });
      g.append(b);
      return b;
    });
    const paint = () => btns.forEach((b, i) => b.classList.toggle('on', this.s[key] === i));
    r.append(g);
    parent.append(r);
    this.syncers.push(paint);
    paint();
    return r;
  }

  buttons(parent: HTMLElement, items: Array<[string, () => void, string?]>) {
    const g = document.createElement('div');
    g.className = 'btns';
    for (const [text, fn, hint] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (hint) b.title = hint;
      b.addEventListener('click', fn);
      g.append(b);
    }
    parent.append(g);
    return g;
  }
}
