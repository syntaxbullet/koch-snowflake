import './style.css';
import { Renderer } from './renderer';
import { Panel } from './ui';
import {
  defaults, presets, fromHash, toHash, maxDepth, equalWidth, GEOM_KEYS,
  type Key, type Settings,
} from './settings';
import type { GeomParams, GeomResult } from './types';

// ───────────────────────────── state ─────────────────────────────
const s: Settings = { ...defaults, ...fromHash(location.hash) };
const canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const panelEl = document.querySelector<HTMLElement>('#panel-body')!;

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  document.body.innerHTML = `<p class="fatal">${(err as Error).message}</p>`;
  throw err;
}

const cam = { zoom: 300, x: 0, y: 0, pivot: [0, 0] as [number, number] };
let geom: GeomResult | null = null;
let needFit = true;
let fitZoom = 1;
let dirty = true;

// ───────────────────────────── geometry worker ─────────────────────────────
const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
let inflight = false;
let pending: GeomParams | null = null;
let lastKey = '';

function wantedParams(): GeomParams {
  const md = maxDepth(s.sides);
  return {
    sides: s.sides,
    level: Math.min(md, Math.max(0, Math.ceil(s.depth - 1e-9))),
    width: s.equal ? equalWidth(s.angle) : s.width,
    angle: s.angle,
    skew: s.skew,
    alternate: s.alternate,
  };
}

/** Request geometry; coalesces so only the latest request is ever queued. */
function requestGeometry() {
  const p = wantedParams();
  const key = JSON.stringify(p);
  if (key === lastKey) return;
  lastKey = key;
  if (inflight) {
    pending = p;
    return;
  }
  inflight = true;
  worker.postMessage({ id: ++reqId, params: p });
}

worker.onmessage = (e: MessageEvent<GeomResult>) => {
  inflight = false;
  geom = e.data;
  renderer.upload(geom);
  if (needFit) fit();
  updateHud();
  dirty = true;
  if (pending) {
    const p = pending;
    pending = null;
    inflight = true;
    worker.postMessage({ id: ++reqId, params: p });
  }
};

// ───────────────────────────── camera ─────────────────────────────
function fit() {
  if (!geom) return;
  const [x0, y0, x1, y1] = geom.bounds;
  const w = Math.max(x1 - x0, 1e-3), h = Math.max(y1 - y0, 1e-3);
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  const panelW = document.body.classList.contains('ui-hidden') || vw < 720 ? 0 : 320;
  cam.zoom = fitZoom = Math.min((vw - panelW) / w, vh / h) * 0.82;
  cam.pivot = [(x0 + x1) / 2, (y0 + y1) / 2];
  cam.x = -panelW / 2;
  cam.y = 0;
  needFit = false;
  dirty = true;
}

/** Morph factor of newest iteration given geometry actually loaded. */
function morphT(): number {
  if (!geom) return 1;
  const L = geom.params.level;
  if (L === 0) return 1;
  return Math.min(1, Math.max(0, s.depth - (L - 1)));
}

// ───────────────────────────── UI ─────────────────────────────
const deg = (v: number) => `${v.toFixed(0)}°`;
const panel = new Panel(panelEl, s, onChange);

const presetSec = panel.section('Presets');
panel.buttons(presetSec, Object.keys(presets).map((name) => [name, () => applyPreset(name)] as [string, () => void]))
  .classList.add('presets');

const it = panel.section('Iteration');
const depthCtl = panel.slider(it, 'Depth', 'depth', 0, maxDepth(s.sides), 0.01, (v) => v.toFixed(2), 'Fractional values morph smoothly between iterations');
panel.toggle(it, 'Animate', 'play', 'Ping-pong between 0 and the target depth (Space)');
const playToCtl = panel.slider(it, 'Animate to', 'playTo', 1, maxDepth(s.sides), 1, (v) => v.toFixed(0));
panel.slider(it, 'Speed', 'playSpeed', 0.05, 3, 0.05, (v) => `${v.toFixed(2)}/s`);

const sh = panel.section('Shape');
panel.slider(sh, 'Sides', 'sides', 1, 12, 1, (v) => (v === 1 ? 'line' : v.toFixed(0)), 'Seed polygon; 1 = Koch curve');
panel.slider(sh, 'Spike angle', 'angle', -88, 88, 0.5, deg, 'Base angle of each spike. Negative points inward');
const widthCtl = panel.slider(sh, 'Spike width', 'width', 0.02, 0.98, 0.001, (v) => v.toFixed(3), 'Fraction of each segment the spike replaces (classic 1/3)');
panel.toggle(sh, 'Equal segments', 'equal', 'Derive width from angle so all four sub-segments are equal (Cesàro)');
panel.slider(sh, 'Skew', 'skew', -1, 1, 0.01, (v) => v.toFixed(2), 'Shift the apex along the spike');
panel.toggle(sh, 'Alternate', 'alternate', 'Flip spike direction every other iteration');

const st = panel.section('Style');
panel.toggle(st, 'Stroke', 'stroke');
panel.slider(st, 'Line width', 'lineWidth', 0.25, 12, 0.05, (v) => `${v.toFixed(2)}px`);
panel.segmented(st, 'Colour', 'colorMode', ['Solid', 'Gradient', 'Rainbow']);
panel.color(st, 'Colour A', 'color1');
panel.color(st, 'Colour B', 'color2');
panel.slider(st, 'Cycles', 'cycles', 0.25, 24, 0.25, (v) => v.toFixed(2), 'Gradient repeats along the curve');
panel.slider(st, 'Colour flow', 'hueSpeed', -2, 2, 0.01, (v) => v.toFixed(2), 'Animate colours along the curve');
panel.toggle(st, 'Additive glow', 'additive', 'Additive blending — reveals line density');
panel.toggle(st, 'Fill', 'fill');
panel.segmented(st, 'Fill type', 'fillMode', ['Solid', 'Radial']);
panel.color(st, 'Fill inner', 'fill1');
panel.color(st, 'Fill outer', 'fill2');
panel.slider(st, 'Fill opacity', 'fillAlpha', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
panel.color(st, 'Background', 'bg');

const vw = panel.section('View', false);
panel.slider(vw, 'Rotation', 'rotation', -180, 180, 0.5, deg);
panel.slider(vw, 'Spin', 'spin', -90, 90, 1, (v) => `${v.toFixed(0)}°/s`);
panel.slider(vw, 'Detail cutoff', 'lod', 0.1, 8, 0.05, (v) => `${v.toFixed(2)}px`,
  'Stop drawing finer iterations once segments are smaller than this on screen. Lower = more detail, slower.');
panel.buttons(vw, [
  ['Fit view', () => fit(), 'F'],
  ['Reset all', resetAll],
]);

const ex = panel.section('Export', false);
panel.buttons(ex, [
  ['PNG', exportPNG, 'Save the current view (P)'],
  ['SVG', exportSVG, 'Vector export of the full shape'],
  ['Copy link', copyLink, 'URL with all settings'],
]);

function updateDerivedUI() {
  const md = maxDepth(s.sides);
  depthCtl.setRange(0, md);
  playToCtl.setRange(1, md);
  widthCtl.el.classList.toggle('disabled', s.equal);
}

function onChange(k: Key) {
  if (k === 'sides') {
    const md = maxDepth(s.sides);
    s.depth = Math.min(s.depth, md);
    s.playTo = Math.min(s.playTo, md);
    needFit = true;
    updateDerivedUI();
    panel.sync();
  }
  if (k === 'equal' || (k === 'angle' && s.equal)) {
    if (s.equal) s.width = equalWidth(s.angle);
    updateDerivedUI();
    panel.sync();
  }
  if (k === 'play' && s.play && s.depth >= s.playTo) playDir = -1;
  if (k === 'depth' || GEOM_KEYS.includes(k)) requestGeometry();
  saveHash();
  dirty = true;
}

function applyPreset(name: string) {
  Object.assign(s, presets[name]);
  if (s.equal) s.width = equalWidth(s.angle);
  needFit = true;
  onChange('sides');
  requestGeometry();
}

function resetAll() {
  Object.assign(s, defaults);
  needFit = true;
  onChange('sides');
  requestGeometry();
}

let hashTimer = 0;
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const h = toHash(s);
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }, 250);
}

// Panel collapse / hide
const app = document.body;
document.querySelector('#toggle-panel')!.addEventListener('click', () => {
  app.classList.toggle('panel-collapsed');
});

// ───────────────────────────── interaction ─────────────────────────────
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { d: number; mx: number; my: number } | null = null;

function zoomAt(cx: number, cy: number, factor: number) {
  // cx, cy: CSS px relative to canvas centre, y up
  const nz = Math.min(1e6, Math.max(5, cam.zoom * factor));
  const f = nz / cam.zoom;
  cam.x = cx - (cx - cam.x) * f;
  cam.y = cy - (cy - cam.y) * f;
  cam.zoom = nz;
  dirty = true;
  hudDirty = true;
}
function rel(e: { clientX: number; clientY: number }) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left - r.width / 2, y: -(e.clientY - r.top - r.height / 2) };
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = rel(e);
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(p.x, p.y, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, rel(e));
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const p = rel(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    cam.x += p.x - prev.x;
    cam.y += p.y - prev.y;
    dirty = true;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinch) {
      cam.x += mx - pinch.mx;
      cam.y += my - pinch.my;
      zoomAt(mx, my, d / pinch.d);
    }
    pinch = { d, mx, my };
  }
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  pinch = null;
  if (!pointers.size) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', () => fit());

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea') && (e.target as HTMLInputElement).type !== 'range' && (e.target as HTMLInputElement).type !== 'checkbox') return;
  const md = maxDepth(s.sides);
  switch (e.key) {
    case ' ': s.play = !s.play; break;
    case 'ArrowUp': case ']': s.depth = Math.min(md, Math.floor(s.depth + 1)); break;
    case 'ArrowDown': case '[': s.depth = Math.max(0, Math.ceil(s.depth - 1)); break;
    case 'f': case 'F': fit(); return;
    case 'h': case 'H': app.classList.toggle('ui-hidden'); return;
    case 'p': case 'P': exportPNG(); return;
    case '+': case '=': zoomAt(0, 0, 1.25); return;
    case '-': case '_': zoomAt(0, 0, 0.8); return;
    default: return;
  }
  e.preventDefault();
  onChange(e.key === ' ' ? 'play' : 'depth');
  panel.sync();
});

// ───────────────────────────── export ─────────────────────────────
function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportPNG() {
  draw(); // drawing buffer is valid until the task ends
  canvas.toBlob((b) => b && download(b, `koch-${geom?.params.level ?? 0}.png`), 'image/png');
}

function exportSVG() {
  if (!geom) return;
  const { data, points, bounds, closed } = geom;
  if (points > 1_100_000 && !confirm(`This SVG will contain ${points.toLocaleString()} points and may be very large. Continue?`)) return;
  const t = morphT();
  const parts: string[] = [];
  for (let i = 0; i < points; i++) {
    const x = data[i * 4 + 2] + (data[i * 4] - data[i * 4 + 2]) * t;
    const y = data[i * 4 + 3] + (data[i * 4 + 1] - data[i * 4 + 3]) * t;
    parts.push(`${i ? 'L' : 'M'}${x.toFixed(5)} ${(-y).toFixed(5)}`);
  }
  const [x0, y0, x1, y1] = bounds;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05;
  const sw = (s.lineWidth / cam.zoom).toFixed(6);
  const fill = s.fill && closed ? `fill="${s.fill1}" fill-opacity="${s.fillAlpha}" fill-rule="evenodd"` : 'fill="none"';
  const stroke = s.stroke ? `stroke="${s.color1}" stroke-width="${sw}" stroke-linejoin="round"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}">
<rect x="${x0 - pad}" y="${-y1 - pad}" width="${x1 - x0 + 2 * pad}" height="${y1 - y0 + 2 * pad}" fill="${s.bg}"/>
<path ${fill} ${stroke} d="${parts.join('')}${closed ? 'Z' : ''}"/>
</svg>`;
  download(new Blob([svg], { type: 'image/svg+xml' }), `koch-${geom.params.level}.svg`);
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}#${toHash(s)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    prompt('Copy this link', url);
  }
}

let toastTimer = 0;
function toast(msg: string) {
  const el = document.querySelector<HTMLElement>('#toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 1600);
}

// ───────────────────────────── loop ─────────────────────────────
let last = performance.now();
let playDir = 1;
let phase = 0;
let frames = 0, fpsT = last, fps = 0;
let lastHud = '';
let hudDirty = false;

function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(dpr);
  const rot = (s.rotation * Math.PI) / 180;
  renderer.draw({
    t: morphT(),
    rotation: rot,
    scale: cam.zoom * dpr,
    offset: [cam.x * dpr, cam.y * dpr],
    pivot: cam.pivot,
    bg: s.bg,
    stroke: s.stroke,
    lineWidth: s.lineWidth * dpr,
    colorMode: s.colorMode,
    color1: s.color1,
    color2: s.color2,
    cycles: s.cycles,
    phase,
    additive: s.additive,
    strokeAlpha: s.additive ? 0.35 : 1,
    fill: s.fill,
    fillMode: s.fillMode,
    fill1: s.fill1,
    fill2: s.fill2,
    fillAlpha: s.fillAlpha,
    lodPx: s.lod * dpr,
    fillRadius: geom ? Math.max(geom.bounds[2] - geom.bounds[0], geom.bounds[3] - geom.bounds[1]) / 2 : 1,
  });
}

function seedPerimeter(n: number) { return n <= 1 ? 2 : n * 2 * Math.sin(Math.PI / n); }
function seedArea(n: number) { return n <= 2 ? 0 : (n / 2) * Math.sin((2 * Math.PI) / n); }

function updateHud() {
  if (!geom) return;
  const g = geom;
  const segs = (g.points - 1).toLocaleString();
  const drawn = renderer.drawnLevel < g.params.level
    ? ` (drawing ${renderer.drawnSegments.toLocaleString()} @ level ${renderer.drawnLevel})`
    : '';
  const per = (g.perimeter / seedPerimeter(g.params.sides)).toFixed(3);
  const sa = seedArea(g.params.sides);
  const area = sa > 0 && g.area > 0 ? ` · area ×${(g.area / sa).toFixed(3)}` : '';
  const animating = s.play || s.spin || s.hueSpeed;
  const zoom = cam.zoom / fitZoom;
  const z = zoom >= 1.05 || zoom <= 0.95 ? ` · zoom ×${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom).toLocaleString()}` : '';
  const text = `depth ${s.depth.toFixed(2)}${z} · ${segs} segments${drawn} · perimeter ×${per}${area} · gen ${g.ms.toFixed(1)}ms${animating ? ` · ${fps} fps` : ''}`;
  if (text !== lastHud) hud.textContent = lastHud = text;
}

function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (s.play) {
    const top = Math.min(s.playTo, maxDepth(s.sides));
    s.depth += playDir * s.playSpeed * dt;
    if (s.depth >= top) { s.depth = top; playDir = -1; }
    if (s.depth <= 0) { s.depth = 0; playDir = 1; }
    requestGeometry();
    panel.sync();
    dirty = true;
  }
  if (s.spin) {
    s.rotation = ((s.rotation + s.spin * dt + 540) % 360) - 180;
    panel.sync();
    dirty = true;
  }
  if (s.hueSpeed) {
    phase = (phase + s.hueSpeed * dt) % 1;
    dirty = true;
  }

  if (dirty) {
    draw();
    dirty = false;
    frames++;
  }
  if (hudDirty) { hudDirty = false; updateHud(); }
  if (now - fpsT > 500) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
    updateHud();
  }
  requestAnimationFrame(tick);
}

new ResizeObserver(() => { dirty = true; }).observe(canvas);
window.addEventListener('hashchange', () => {
  Object.assign(s, defaults, fromHash(location.hash));
  needFit = true;
  updateDerivedUI();
  panel.sync();
  requestGeometry();
  dirty = true;
});

updateDerivedUI();
requestGeometry();
requestAnimationFrame(tick);
