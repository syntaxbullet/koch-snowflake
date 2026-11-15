/// <reference lib="webworker" />
import type { GeomParams, GeomRequest, GeomResult } from './types';

const DEG = Math.PI / 180;

/** Seed shape as a flat [x0, y0, x1, y1, ...] polyline. Closed shapes repeat the first point. */
function seed(sides: number): Float64Array {
  if (sides <= 1) {
    // Single segment, traversed right-to-left so the "right-hand" normal points up.
    return new Float64Array([1, -0.25, -1, -0.25]);
  }
  const out = new Float64Array((sides + 1) * 2);
  // Counter-clockwise polygon, circumradius 1, one vertex pointing up for odd counts
  // and a flat bottom edge for even counts.
  const start = Math.PI / 2 + (sides % 2 === 0 ? Math.PI / sides : 0);
  for (let i = 0; i <= sides; i++) {
    const a = start + ((i % sides) / sides) * Math.PI * 2;
    out[i * 2] = Math.cos(a);
    out[i * 2 + 1] = Math.sin(a);
  }
  return out;
}

function generate(p: GeomParams): Omit<GeomResult, 'id' | 'params' | 'ms'> {
  const w = Math.min(Math.max(p.width, 0.001), 0.999);
  const lo = (1 - w) / 2; // start of spike along segment
  const hi = (1 + w) / 2; // end of spike along segment
  const u = 0.5 + 0.5 * p.skew; // apex position along spike base
  const ux = lo + u * w;
  const hf = (w / 2) * Math.tan(p.angle * DEG); // apex height / segment length

  let pts = seed(p.sides);
  const closed = p.sides > 1;

  // Expand all levels except the last in float64.
  for (let lvl = 1; lvl < p.level; lvl++) {
    const s = p.alternate && lvl % 2 === 0 ? -hf : hf;
    const n = pts.length / 2;
    const next = new Float64Array(((n - 1) * 4 + 1) * 2);
    let o = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      const dx = pts[i * 2 + 2] - ax, dy = pts[i * 2 + 3] - ay;
      next[o++] = ax; next[o++] = ay;
      next[o++] = ax + dx * lo; next[o++] = ay + dy * lo;
      // right-hand normal (dy, -dx) points outward for a CCW polygon
      next[o++] = ax + dx * ux + dy * s; next[o++] = ay + dy * ux - dx * s;
      next[o++] = ax + dx * hi; next[o++] = ay + dy * hi;
    }
    next[o++] = pts[(n - 1) * 2];
    next[o++] = pts[(n - 1) * 2 + 1];
    pts = next;
  }

  // Final level: write interleaved [x, y, baseX, baseY] float32 directly.
  let data: Float32Array;
  if (p.level === 0) {
    const n = pts.length / 2;
    data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = data[i * 4 + 2] = pts[i * 2];
      data[i * 4 + 1] = data[i * 4 + 3] = pts[i * 2 + 1];
    }
  } else {
    const s = p.alternate && p.level % 2 === 0 ? -hf : hf;
    const n = pts.length / 2;
    data = new Float32Array(((n - 1) * 4 + 1) * 4);
    let o = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      const dx = pts[i * 2 + 2] - ax, dy = pts[i * 2 + 3] - ay;
      const p1x = ax + dx * lo, p1y = ay + dy * lo;
      const bx = ax + dx * ux, by = ay + dy * ux;
      const p2x = ax + dx * hi, p2y = ay + dy * hi;
      data[o++] = ax; data[o++] = ay; data[o++] = ax; data[o++] = ay;
      data[o++] = p1x; data[o++] = p1y; data[o++] = p1x; data[o++] = p1y;
      data[o++] = bx + dy * s; data[o++] = by - dx * s; data[o++] = bx; data[o++] = by;
      data[o++] = p2x; data[o++] = p2y; data[o++] = p2x; data[o++] = p2y;
    }
    const lx = pts[(n - 1) * 2], ly = pts[(n - 1) * 2 + 1];
    data[o++] = lx; data[o++] = ly; data[o++] = lx; data[o++] = ly;
  }

  // Stats: perimeter, signed-area magnitude, bounds.
  const points = data.length / 4;
  let perimeter = 0, area = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let px = data[0], py = data[1];
  for (let i = 0; i < points; i++) {
    const x = data[i * 4], y = data[i * 4 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (i > 0) {
      perimeter += Math.hypot(x - px, y - py);
      area += px * y - x * py;
    }
    px = x; py = y;
  }

  // Average segment length per level. Level-k vertices sit at stride 4^(level-k).
  const seedSegs = closed ? p.sides : 1;
  const levelLen: number[] = [];
  for (let k = 0; k <= p.level; k++) {
    const stride = 4 ** (p.level - k);
    const segs = seedSegs * 4 ** k;
    let len = 0;
    for (let s = 0; s < segs; s++) {
      const a = s * stride * 4, b = (s + 1) * stride * 4;
      len += Math.hypot(data[b] - data[a], data[b + 1] - data[a + 1]);
    }
    levelLen.push(len / segs);
  }

  return {
    data,
    levelLen,
    points,
    closed,
    perimeter,
    area: closed ? Math.abs(area) / 2 : 0,
    bounds: [minX, minY, maxX, maxY],
  };
}

self.onmessage = (e: MessageEvent<GeomRequest>) => {
  const t0 = performance.now();
  const res = generate(e.data.params);
  const msg: GeomResult = { id: e.data.id, params: e.data.params, ms: performance.now() - t0, ...res };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, [res.data.buffer]);
};
