import './style.css';
import { Renderer } from './renderer';
import { Panel } from './ui';
import { Shape, Builder, normalize, seedFrame, type Frame, type BuildResult } from './fractal';
import { defaults, presets, fromHash, toHash, equalWidth, GEOM_KEYS, DEPTH_MAX, type Key, type Settings } from './settings';

// ───────────────────────────── state ─────────────────────────────
const s: Settings = { ...defaults, ...fromHash(location.hash) };
const canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const panelEl = document.querySelector<HTMLElement>('#panel')!;
const panelBody = document.querySelector<HTMLElement>('#panel-body')!;

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  document.body.innerHTML = `<p class="fatal">${(err as Error).message}</p>`;
  throw err;
}

const shapeParams = () => ({
  sides: s.sides,
  width: s.equal ? equalWidth(s.angle) : s.width,
  angle: s.angle,
  skew: s.skew,
  alternate: s.alternate,
});
let shape = new Shape(shapeParams());
const builder = new Builder();
let built: BuildResult | null = null;

/** Camera: tree address + similarity to screen (CSS px, y up, centred). */
let cam: Frame = { addr: [0], ar: 1, ai: 0, br: 0, bi: 0 };
let theta = 0; // view rotation, radians
let logZoom = 0; // ln(zoom relative to fit)
let geomDirty = true;
let dirty = true;
let hudDirty = true;
let rotationSyncPending = false;
let hintShown = false;
/** Until the user moves the view, keep it fitted across resizes/layout changes. */
let autoFit = true;

const DEG = Math.PI / 180;
const MIN_LOG_ZOOM = Math.log(0.05);
const MAX_FINITE_LOG_ZOOM = Math.log(1e9);

// ───────────────────────────── view helpers ─────────────────────────────
function dprNow() {
  return Math.min(window.devicePixelRatio || 1, 2);
}
function diag() {
  return Math.hypot(canvas.clientWidth, canvas.clientHeight);
}
/** Visible area not covered by the panel: centre (CSS px, y up) and size. */
function viewArea() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  let vcx = 0, vcy = 0, aw = W, ah = H;
  const hidden = document.body.classList.contains('ui-hidden') || document.body.classList.contains('panel-collapsed');
  if (!hidden) {
    const r = panelEl.getBoundingClientRect();
    if (W > 720) {
      aw = W - r.width - 32;
      vcx = -(r.width + 16) / 2;
    } else {
      ah = H - r.height - 16;
      vcy = (r.height + 8) / 2;
    }
  }
  return { vcx, vcy, aw: Math.max(aw, 100), ah: Math.max(ah, 100) };
}

function fit() {
  const [x0, y0, x1, y1] = shape.bounds;
  const w = Math.max(x1 - x0, 1e-3), h = Math.max(y1 - y0, 1e-3);
  const { vcx, vcy, aw, ah } = viewArea();
  const zoom = Math.min(aw / w, ah / h) * 0.86;
  theta = s.rotation * DEG;
  cam = seedFrame(shape, zoom * Math.cos(theta), zoom * Math.sin(theta), (x0 + x1) / 2, (y0 + y1) / 2, vcx, vcy);
  logZoom = 0;
  normalize(shape, cam, vcx, vcy, diag());
  geomDirty = true;
  hudDirty = true;
  hintShown = false;
  autoFit = true;
}

/**
 * Apply the similarity z → q + (z − p)·k to the view (pan / zoom / rotate in one).
 * All camera motion goes through here.
 */
function transform(kr: number, ki: number, px: number, py: number, qx: number, qy: number) {
  const mag = Math.hypot(kr, ki);
  if (!(mag > 0)) return;
  autoFit = false;
  const maxL = s.infinite ? Infinity : MAX_FINITE_LOG_ZOOM;
  const nl = Math.min(maxL, Math.max(MIN_LOG_ZOOM, logZoom + Math.log(mag)));
  const f = Math.exp(nl - logZoom) / mag;
  kr *= f;
  ki *= f;
  logZoom = nl;
  const dx = cam.br - px, dy = cam.bi - py;
  cam.br = qx + dx * kr - dy * ki;
  cam.bi = qy + dx * ki + dy * kr;
  const ar = cam.ar * kr - cam.ai * ki;
  cam.ai = cam.ar * ki + cam.ai * kr;
  cam.ar = ar;
  if (ki !== 0) {
    theta += Math.atan2(ki, kr);
    s.rotation = ((((theta / DEG + 180) % 360) + 360) % 360) - 180;
    rotationSyncPending = true;
  }
  const { vcx, vcy } = viewArea();
  normalize(shape, cam, vcx, vcy, diag());
  geomDirty = true;
  hudDirty = true;
}
const zoomAt = (x: number, y: number, f: number) => transform(f, 0, x, y, x, y);
const pan = (dx: number, dy: number) => transform(1, 0, 0, 0, dx, dy);
const rotateAbout = (x: number, y: number, a: number) => transform(Math.cos(a), Math.sin(a), x, y, x, y);

function iterLevel() {
  if (s.infinite) return { L: Infinity, t: 1 };
  const L = Math.min(DEPTH_MAX, Math.max(0, Math.ceil(s.depth - 1e-9)));
  return { L, t: L === 0 ? 1 : Math.min(1, Math.max(0, s.depth - (L - 1))) };
}

// ───────────────────────────── UI ─────────────────────────────
const deg = (v: number) => `${v.toFixed(0)}°`;
const panel = new Panel(panelBody, s, onChange);

const presetSec = panel.section('Presets');
panel.buttons(presetSec, Object.keys(presets).map((name) => [name, () => applyPreset(name)] as [string, () => void]))
  .classList.add('presets');

const it = panel.section('Iteration');
panel.toggle(it, 'Infinite depth', 'infinite', 'Unlimited detail — keep zooming forever (I)');
const depthRows = [
  panel.slider(it, 'Depth', 'depth', 0, DEPTH_MAX, 0.01, (v) => v.toFixed(2), 'Fractional values morph smoothly between iterations').el,
  panel.toggle(it, 'Animate', 'play', 'Ping-pong between 0 and the target depth (Space)'),
  panel.slider(it, 'Animate to', 'playTo', 1, DEPTH_MAX, 1, (v) => v.toFixed(0)).el,
  panel.slider(it, 'Speed', 'playSpeed', 0.05, 3, 0.05, (v) => `${v.toFixed(2)}/s`).el,
];

const sh = panel.section('Shape');
panel.slider(sh, 'Sides', 'sides', 1, 12, 1, (v) => (v === 1 ? 'line' : v.toFixed(0)), 'Seed polygon; 1 = Koch curve');
panel.slider(sh, 'Spike angle', 'angle', -88, 88, 0.5, deg, 'Base angle of each spike. Negative points inward');
const widthRow = panel.slider(sh, 'Spike width', 'width', 0.02, 0.98, 0.001, (v) => v.toFixed(3), 'Fraction of each segment the spike replaces (classic 1/3)').el;
panel.toggle(sh, 'Equal segments', 'equal', 'Derive width from angle so all four sub-segments are equal (Cesàro)');
panel.slider(sh, 'Skew', 'skew', -1, 1, 0.01, (v) => v.toFixed(2), 'Shift the apex along the spike');
panel.toggle(sh, 'Alternate', 'alternate', 'Flip spike direction every other iteration');

const st = panel.section('Style');
panel.toggle(st, 'Stroke', 'stroke');
panel.slider(st, 'Line width', 'lineWidth', 0.25, 12, 0.05, (v) => `${v.toFixed(2)}px`);
panel.segmented(st, 'Colour', 'colorMode', ['Solid', 'Gradient', 'Rainbow']);
panel.segmented(st, 'Colour by', 'colorBy', ['Path', 'Direction']);
panel.color(st, 'Colour A', 'color1');
panel.color(st, 'Colour B', 'color2');
panel.slider(st, 'Cycles', 'cycles', 0.25, 24, 0.25, (v) => v.toFixed(2), 'Gradient repeats');
panel.slider(st, 'Colour flow', 'hueSpeed', -2, 2, 0.01, (v) => v.toFixed(2), 'Animate colours');
panel.toggle(st, 'Additive glow', 'additive', 'Additive blending — reveals line density');
panel.toggle(st, 'Fill', 'fill');
panel.segmented(st, 'Fill type', 'fillMode', ['Solid', 'Radial']);
panel.color(st, 'Fill inner', 'fill1');
panel.color(st, 'Fill outer', 'fill2');
panel.slider(st, 'Fill opacity', 'fillAlpha', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
panel.color(st, 'Background', 'bg');

const vw = panel.section('View');
panel.slider(vw, 'Auto zoom', 'autoZoom', -2, 3, 0.05, (v) => (v === 0 ? 'off' : `×${(2 ** v).toFixed(2)}/s`), 'Continuously zoom toward the view centre');
panel.toggle(vw, 'Follow curve', 'follow', 'While auto-zooming, steer toward the nearest point on the curve');
panel.slider(vw, 'Rotation', 'rotation', -180, 180, 0.5, deg);
panel.slider(vw, 'Spin', 'spin', -90, 90, 1, (v) => `${v.toFixed(0)}°/s`);
panel.slider(vw, 'Detail cutoff', 'lod', 0.1, 8, 0.05, (v) => `${v.toFixed(2)}px`,
  'Stop subdividing once segments are smaller than this on screen. Lower = more detail, slower.');
panel.buttons(vw, [
  ['Fit view', () => fit(), 'F / double-click / double-tap'],
  ['Fly in ∞', flyIn, 'Infinite depth + auto zoom'],
  ['Reset all', resetAll],
]);

const ex = panel.section('Export', false);
panel.buttons(ex, [
  ['PNG', exportPNG, 'Save the current view (P)'],
  ['SVG', exportSVG, 'Vector export of the current view'],
  ['Copy link', copyLink, 'URL with all settings'],
]);

function updateDerivedUI() {
  for (const r of depthRows) r.classList.toggle('disabled', s.infinite);
  widthRow.classList.toggle('disabled', s.equal);
}

function onChange(k: Key) {
  if (GEOM_KEYS.includes(k)) {
    if (s.equal) s.width = equalWidth(s.angle);
    shape = new Shape(shapeParams());
    if (k === 'sides') fit();
    else {
      const { vcx, vcy } = viewArea();
      normalize(shape, cam, vcx, vcy, diag());
    }
    updateDerivedUI();
    panel.sync();
  }
  if (k === 'infinite') {
    if (!s.infinite && logZoom > MAX_FINITE_LOG_ZOOM) fit();
    if (s.infinite) s.play = false;
    updateDerivedUI();
    panel.sync();
  }
  if (k === 'rotation') {
    const d = ((((s.rotation * DEG - theta) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const { vcx, vcy } = viewArea();
    rotateAbout(vcx, vcy, d);
  }
  if (k === 'play' && s.play && s.depth >= s.playTo) playDir = -1;
  if (GEOM_KEYS.includes(k) || ['depth', 'infinite', 'lod', 'fill', 'lineWidth', 'stroke'].includes(k)) geomDirty = true;
  saveHash();
  dirty = true;
  hudDirty = true;
}

function applyPreset(name: string) {
  Object.assign(s, presets[name]);
  onChange('sides');
}

function resetAll() {
  Object.assign(s, defaults);
  onChange('sides');
  onChange('infinite');
}

function flyIn() {
  s.infinite = true;
  if (!(s.autoZoom > 0)) s.autoZoom = 1;
  s.follow = true;
  onChange('infinite');
}

let hashTimer = 0;
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const h = toHash(s);
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }, 250);
}

document.querySelector('#toggle-panel')!.addEventListener('click', () => {
  document.body.classList.toggle('panel-collapsed');
});

// ───────────────────────────── interaction ─────────────────────────────
function rel(e: { clientX: number; clientY: number }) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left - r.width / 2, y: -(e.clientY - r.top - r.height / 2) };
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = rel(e);
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  // ctrlKey = trackpad pinch on desktop browsers
  zoomAt(p.x, p.y, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

const pointers = new Map<number, { x: number; y: number }>();
/** Two-finger gesture state: rotation only engages after a deliberate twist. */
let gesture: { twist: number; rotating: boolean } | null = null;
let lastTap = { t: 0, x: 0, y: 0 };
const ROTATE_THRESHOLD = 12 * DEG;

canvas.addEventListener('pointerdown', (e) => {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already gone; capture is a nicety */
  }
  const p = rel(e);
  pointers.set(e.pointerId, p);
  canvas.classList.add('dragging');
  if (pointers.size === 2) gesture = { twist: 0, rotating: false };
  if (e.pointerType === 'touch' && pointers.size === 1) {
    const now = performance.now();
    if (now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      fit();
      lastTap.t = 0;
    } else lastTap = { t: now, x: p.x, y: p.y };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const p = rel(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    if (e.shiftKey) {
      // shift-drag rotates around the view centre
      const { vcx, vcy } = viewArea();
      const a0 = Math.atan2(prev.y - vcy, prev.x - vcx);
      const a1 = Math.atan2(p.y - vcy, p.x - vcx);
      rotateAbout(vcx, vcy, a1 - a0);
    } else pan(p.x - prev.x, p.y - prev.y);
  } else if (pointers.size === 2 && gesture) {
    let other: { x: number; y: number } | undefined;
    for (const [id, q] of pointers) if (id !== e.pointerId) other = q;
    if (!other) return;
    // similarity mapping the old finger pair (prev, other) onto the new pair (p, other)
    const ox = other.x - prev.x, oy = other.y - prev.y;
    const nx = other.x - p.x, ny = other.y - p.y;
    const den = ox * ox + oy * oy;
    if (den < 1) return;
    const kr = (nx * ox + ny * oy) / den;
    const ki = (ny * ox - nx * oy) / den;
    if (!gesture.rotating) {
      gesture.twist += Math.atan2(ki, kr);
      if (Math.abs(gesture.twist) > ROTATE_THRESHOLD) gesture.rotating = true;
    }
    if (gesture.rotating) {
      transform(kr, ki, prev.x, prev.y, p.x, p.y);
    } else {
      // scale + pan only, around the finger midpoint
      transform(Math.hypot(kr, ki), 0, (prev.x + other.x) / 2, (prev.y + other.y) / 2, (p.x + other.x) / 2, (p.y + other.y) / 2);
    }
  }
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (!pointers.size) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', () => fit());

// iOS Safari: stop native page pinch/zoom gestures from fighting ours
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

window.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLInputElement;
  if (tgt.closest?.('input, textarea') && tgt.type !== 'range' && tgt.type !== 'checkbox') return;
  const { vcx, vcy } = viewArea();
  let key: Key | null = null;
  switch (e.key) {
    case ' ': if (!s.infinite) { s.play = !s.play; key = 'play'; } break;
    case 'ArrowUp': case ']': if (!s.infinite) { s.depth = Math.min(DEPTH_MAX, Math.floor(s.depth + 1)); key = 'depth'; } break;
    case 'ArrowDown': case '[': if (!s.infinite) { s.depth = Math.max(0, Math.ceil(s.depth - 1)); key = 'depth'; } break;
    case 'i': case 'I': s.infinite = !s.infinite; key = 'infinite'; break;
    case 'f': case 'F': fit(); return;
    case 'h': case 'H': document.body.classList.toggle('ui-hidden'); return;
    case 'p': case 'P': exportPNG(); return;
    case '+': case '=': zoomAt(vcx, vcy, 1.25); return;
    case '-': case '_': zoomAt(vcx, vcy, 0.8); return;
    default: return;
  }
  e.preventDefault();
  if (key) {
    onChange(key);
    panel.sync();
  }
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
  canvas.toBlob((b) => b && download(b, 'koch-snowflake.png'), 'image/png');
}

function exportSVG() {
  if (!built) return;
  const dpr = dprNow();
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const X = (x: number) => (x / dpr + W / 2).toFixed(2);
  const Y = (y: number) => (H / 2 - y / dpr).toFixed(2);
  const { seg, segCount, tri, triVerts } = built;
  const strokeParts: string[] = [];
  let px = NaN, py = NaN;
  for (let i = 0; i < segCount; i++) {
    const o = i * 8;
    if (Math.abs(seg[o] - px) > 1e-3 || Math.abs(seg[o + 1] - py) > 1e-3) strokeParts.push(`M${X(seg[o])} ${Y(seg[o + 1])}`);
    strokeParts.push(`L${X(seg[o + 2])} ${Y(seg[o + 3])}`);
    px = seg[o + 2];
    py = seg[o + 3];
  }
  const fillParts: string[] = [];
  for (let i = 0; i < triVerts; i += 3) {
    const o = i * 2;
    fillParts.push(`M${X(tri[o])} ${Y(tri[o + 1])}L${X(tri[o + 2])} ${Y(tri[o + 3])}L${X(tri[o + 4])} ${Y(tri[o + 5])}Z`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="${s.bg}"/>
${s.fill && fillParts.length ? `<path fill="${s.fill1}" fill-opacity="${s.fillAlpha}" fill-rule="evenodd" d="${fillParts.join('')}"/>` : ''}
${s.stroke ? `<path fill="none" stroke="${s.color1}" stroke-width="${s.lineWidth}" stroke-linejoin="round" stroke-linecap="round" d="${strokeParts.join('')}"/>` : ''}
</svg>`;
  download(new Blob([svg], { type: 'image/svg+xml' }), 'koch-snowflake.svg');
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
function toast(msg: string, ms = 1600) {
  const el = document.querySelector<HTMLElement>('#toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

// ───────────────────────────── build + draw ─────────────────────────────
let phase = 0;

function rebuild() {
  const dpr = dprNow();
  const { L, t } = iterLevel();
  const { vcx, vcy } = viewArea();
  built = builder.build(shape, cam, {
    dpr,
    width: canvas.width,
    height: canvas.height,
    lodPx: s.lod * dpr,
    maxLevel: L,
    t,
    fill: s.fill,
    pad: (s.lineWidth + 2) * dpr,
    vcx,
    vcy,
  });
  renderer.setGeometry(built.seg, built.segCount, built.tri, built.triVerts);
  hudDirty = true;
  if (!s.infinite && built.capped > 0 && logZoom > Math.log(4) && !hintShown) {
    hintShown = true;
    toast('Out of detail at this depth — turn on Infinite depth (I) to keep zooming', 3500);
  }
}

function draw() {
  const dpr = dprNow();
  if (renderer.resize(dpr)) geomDirty = true;
  if (geomDirty) {
    rebuild();
    geomDirty = false;
  }
  renderer.draw({
    bg: s.bg,
    stroke: s.stroke,
    lineWidth: s.lineWidth * dpr,
    colorMode: s.colorMode,
    colorBy: s.colorBy,
    theta,
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
    fillCenter: built?.fillCenter ?? [0, 0],
    fillRadius: built?.fillRadius ?? 1,
  });
}

// ───────────────────────────── HUD ─────────────────────────────
let lastHud = '';
let fps = 0;

function fmtZoom(lz: number) {
  if (lz < Math.log(1e4)) {
    const z = Math.exp(lz);
    return z < 10 ? z.toFixed(1) : Math.round(z).toLocaleString();
  }
  const e10 = lz / Math.LN10;
  const exp = Math.floor(e10);
  return `${(10 ** (e10 - exp)).toFixed(1)}e${exp}`;
}

function updateHud() {
  if (!built) return;
  const { L, t } = iterLevel();
  const stats = shape.stats(L, t);
  const parts = [
    `depth ${s.infinite ? '∞' : s.depth.toFixed(2)}`,
    Math.abs(logZoom) > 0.05 ? `zoom ×${fmtZoom(logZoom)}` : '',
    `${Number.isFinite(stats.segments) ? stats.segments.toLocaleString() : '∞'} segments`,
    `drawing ${built.segCount.toLocaleString()} (level ${built.deepest})`,
    `perimeter ×${Number.isFinite(stats.perimeter) ? stats.perimeter.toFixed(3) : '∞'}`,
    Number.isFinite(stats.area) ? `area ×${stats.area.toFixed(3)}` : '',
    `build ${built.ms.toFixed(1)}ms`,
    s.play || s.spin || s.hueSpeed || s.autoZoom ? `${fps} fps` : '',
  ];
  const text = parts.filter(Boolean).join(' · ');
  if (text !== lastHud) hud.textContent = lastHud = text;
}

// ───────────────────────────── loop ─────────────────────────────
let last = performance.now();
let playDir = 1;
let frames = 0, fpsT = last;

function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { vcx, vcy } = viewArea();

  if (s.play && !s.infinite) {
    const top = Math.min(s.playTo, DEPTH_MAX);
    s.depth += playDir * s.playSpeed * dt;
    if (s.depth >= top) { s.depth = top; playDir = -1; }
    if (s.depth <= 0) { s.depth = 0; playDir = 1; }
    geomDirty = true;
    panel.sync();
  }
  if (s.spin) rotateAbout(vcx, vcy, s.spin * DEG * dt);
  if (s.autoZoom) {
    zoomAt(vcx, vcy, 2 ** (s.autoZoom * dt));
    if (s.follow && built?.nearest) {
      const k = Math.min(1, 2.5 * dt);
      pan((vcx - built.nearest[0]) * k, (vcy - built.nearest[1]) * k);
    }
  }
  if (s.hueSpeed) {
    phase = (phase + s.hueSpeed * dt) % 1;
    dirty = true;
  }
  if (rotationSyncPending) {
    rotationSyncPending = false;
    panel.sync();
  }

  if (dirty || geomDirty) {
    draw();
    dirty = false;
    frames++;
  }
  if (hudDirty) {
    hudDirty = false;
    updateHud();
  }
  if (now - fpsT > 500) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
    updateHud();
  }
  requestAnimationFrame(tick);
}

const ro = new ResizeObserver(() => {
  if (autoFit) fit();
  geomDirty = true;
});
ro.observe(canvas);
ro.observe(panelEl);
window.addEventListener('hashchange', () => {
  Object.assign(s, defaults, fromHash(location.hash));
  shape = new Shape(shapeParams());
  updateDerivedUI();
  panel.sync();
  fit();
});

updateDerivedUI();
fit();
requestAnimationFrame(tick);

// Dev-only hook for automated testing (stripped from production builds).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __koch: { zoomAt, pan, fit, viewArea, get built() { return built; }, get cam() { return cam; }, get logZoom() { return logZoom; }, draw },
  });
}
