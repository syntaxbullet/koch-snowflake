/**
 * Fractal core: shape definition, a precision-free camera and a view-dependent
 * geometry builder.
 *
 * ## Camera
 * Floating point runs out of precision around 10^7× zoom, so the camera is not a
 * world-space position. It is an *address* in the subdivision tree — seed side
 * index followed by child digits 0..3 — plus a similarity transform mapping that
 * segment's local unit frame ([0,1] on the real axis) to screen pixels:
 *
 *     screen(z) = A·z + B          (A, B complex, in CSS px, y up, origin = canvas centre)
 *
 * The camera is kept "normalised": it always points at a segment roughly the
 * size of the screen near the view centre. All numbers stay screen-sized no
 * matter how deep you zoom, so zoom is unbounded.
 *
 * ## Builder
 * Each frame we walk up from the camera segment to a "render root" that covers
 * the screen, gather its neighbours along the curve, and recurse down — culling
 * anything off-screen and stopping once segments are ~1 px. The cost depends
 * on screen size, not on zoom or depth.
 *
 * Fill uses even-odd parity: the level-n region = seed polygon XOR every spike
 * triangle of every level, so we emit those triangles (plus a base polygon)
 * and let the stencil buffer do the rest.
 */

const DEG = Math.PI / 180;

export interface ShapeParams {
  sides: number;
  width: number;
  angle: number;
  skew: number;
  alternate: boolean;
}

export class Shape {
  readonly nSeed: number;
  readonly closed: boolean;
  readonly w: number;
  readonly lo: number;
  readonly hi: number;
  readonly ux: number;
  readonly hf: number;
  readonly alternate: boolean;
  /** Seed vertices (nSeed + 1, closed shapes repeat the first). */
  readonly vx: number[] = [];
  readonly vy: number[] = [];
  /** Seed side vectors. */
  readonly sx: number[] = [];
  readonly sy: number[] = [];
  /** Subtree of a segment lies within |A|·rho of its midpoint. */
  rho = 0.5;
  /** World bounds of the fully grown shape. */
  bounds: [number, number, number, number] = [-1, -1, 1, 1];
  /** Max distance of the fully grown shape from the world origin. */
  radius = 1;

  constructor(p: ShapeParams) {
    this.w = Math.min(Math.max(p.width, 0.001), 0.999);
    this.lo = (1 - this.w) / 2;
    this.hi = (1 + this.w) / 2;
    this.ux = this.lo + (0.5 + 0.5 * p.skew) * this.w;
    this.hf = (this.w / 2) * Math.tan(p.angle * DEG);
    this.alternate = p.alternate;

    if (p.sides <= 1) {
      // single segment traversed right-to-left so spikes point up
      this.nSeed = 1;
      this.closed = false;
      this.vx.push(1, -1);
      this.vy.push(-0.25, -0.25);
    } else {
      this.nSeed = p.sides;
      this.closed = true;
      const start = Math.PI / 2 + (p.sides % 2 === 0 ? Math.PI / p.sides : 0);
      for (let i = 0; i <= p.sides; i++) {
        const a = start + ((i % p.sides) / p.sides) * Math.PI * 2;
        this.vx.push(Math.cos(a));
        this.vy.push(Math.sin(a));
      }
    }
    for (let i = 0; i < this.nSeed; i++) {
      this.sx.push(this.vx[i + 1] - this.vx[i]);
      this.sy.push(this.vy[i + 1] - this.vy[i]);
    }

    // Sample the unit curve to bound subtrees (rho) and the whole shape.
    let rho = 0.5;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rad = 0;
    for (const startLevel of [1, 2]) {
      const pts = this.unitCurve(7, startLevel);
      for (let i = 0; i < pts.length; i += 2) {
        rho = Math.max(rho, Math.hypot(pts[i] - 0.5, pts[i + 1]));
      }
      if (startLevel !== 1) continue;
      for (let s = 0; s < this.nSeed; s++) {
        for (let i = 0; i < pts.length; i += 2) {
          const x = this.vx[s] + this.sx[s] * pts[i] - this.sy[s] * pts[i + 1];
          const y = this.vy[s] + this.sy[s] * pts[i] + this.sx[s] * pts[i + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          rad = Math.max(rad, Math.hypot(x, y));
        }
      }
    }
    this.rho = rho * 1.03 + 0.01;
    this.bounds = [x0, y0, x1, y1];
    this.radius = rad;
  }

  sign(k: number) {
    return this.alternate && (k & 1) === 0 ? -1 : 1;
  }

  /** Points of the unit segment expanded `levels` times, first new level = startLevel. */
  private unitCurve(levels: number, startLevel: number): Float64Array {
    let pts = new Float64Array([0, 0, 1, 0]);
    for (let l = 0; l < levels; l++) {
      const s = this.hf * this.sign(startLevel + l);
      const n = pts.length / 2;
      const next = new Float64Array(((n - 1) * 4 + 1) * 2);
      let o = 0;
      for (let i = 0; i < n - 1; i++) {
        const ax = pts[i * 2], ay = pts[i * 2 + 1];
        const dx = pts[i * 2 + 2] - ax, dy = pts[i * 2 + 3] - ay;
        next[o++] = ax; next[o++] = ay;
        next[o++] = ax + dx * this.lo; next[o++] = ay + dy * this.lo;
        next[o++] = ax + dx * this.ux + dy * s; next[o++] = ay + dy * this.ux - dx * s;
        next[o++] = ax + dx * this.hi; next[o++] = ay + dy * this.hi;
      }
      next[o++] = 1; next[o++] = 0;
      pts = next;
    }
    return pts;
  }

  /**
   * Child j of a segment, for children created at level k with morph t.
   * Writes [qx, qy, cx, cy] — start point and vector in the parent's unit frame.
   */
  child(j: number, k: number, t: number, out: Float64Array) {
    const s = this.hf * this.sign(k) * t;
    // q0=(0,0) q1=(lo,0) q2=(ux,-s) q3=(hi,0) q4=(1,0)
    switch (j) {
      case 0: out[0] = 0; out[1] = 0; out[2] = this.lo; out[3] = 0; break;
      case 1: out[0] = this.lo; out[1] = 0; out[2] = this.ux - this.lo; out[3] = -s; break;
      case 2: out[0] = this.ux; out[1] = -s; out[2] = this.hi - this.ux; out[3] = s; break;
      default: out[0] = this.hi; out[1] = 0; out[2] = this.lo; out[3] = 0;
    }
  }

  /** Analytic stats at iteration depth (level L, morph t). Infinity for unlimited. */
  stats(L: number, t: number) {
    const c1 = Math.hypot(this.ux - this.lo, this.hf);
    const c2 = Math.hypot(this.hi - this.ux, this.hf);
    const sumC = 2 * this.lo + c1 + c2;
    const sumC2 = 2 * this.lo * this.lo + c1 * c1 + c2 * c2;
    let P0 = 0, S0 = 0;
    for (let i = 0; i < this.nSeed; i++) {
      const l2 = this.sx[i] ** 2 + this.sy[i] ** 2;
      P0 += Math.sqrt(l2);
      S0 += l2;
    }
    let A0 = 0;
    if (this.closed && this.nSeed >= 3) {
      for (let i = 0; i < this.nSeed; i++) A0 += this.vx[i] * this.vy[i + 1] - this.vx[i + 1] * this.vy[i];
      A0 /= 2;
    }
    const tri = (this.w * this.hf) / 2; // signed spike area per unit² of parent length

    if (!Number.isFinite(L)) {
      const per = sumC > 1 ? Infinity : sumC < 1 ? 0 : 1;
      let area = NaN;
      if (sumC2 < 1) area = A0 + (tri * S0) / (this.alternate ? 1 + sumC2 : 1 - sumC2);
      return { perimeter: per, area: A0 > 0 ? area / A0 : NaN, segments: Infinity };
    }
    let perimeter = P0;
    if (L > 0) {
      const c1t = Math.hypot(this.ux - this.lo, this.hf * t);
      const c2t = Math.hypot(this.hi - this.ux, this.hf * t);
      perimeter = P0 * sumC ** (L - 1) * (2 * this.lo + c1t + c2t);
    }
    let area = A0;
    for (let k = 1; k <= L; k++) area += tri * this.sign(k) * (k === L ? t : 1) * S0 * sumC2 ** (k - 1);
    return { perimeter: perimeter / P0, area: A0 > 0 ? area / A0 : NaN, segments: this.nSeed * 4 ** L };
  }
}

// ─────────────────────────── camera frames ───────────────────────────

export interface Frame {
  /** [seed side, digit at level 1, digit at level 2, ...] */
  addr: number[];
  ar: number;
  ai: number;
  br: number;
  bi: number;
}

const tmp = new Float64Array(4);
const tmp2 = new Float64Array(4);

export const levelOf = (f: Frame) => f.addr.length - 1;
export const cloneFrame = (f: Frame): Frame => ({ addr: f.addr.slice(), ar: f.ar, ai: f.ai, br: f.br, bi: f.bi });

export function descend(sh: Shape, f: Frame, j: number) {
  sh.child(j, f.addr.length, 1, tmp);
  const [qx, qy, cx, cy] = tmp;
  f.br += f.ar * qx - f.ai * qy;
  f.bi += f.ar * qy + f.ai * qx;
  const ar = f.ar * cx - f.ai * cy;
  f.ai = f.ar * cy + f.ai * cx;
  f.ar = ar;
  f.addr.push(j);
}

export function ascend(sh: Shape, f: Frame) {
  const k = f.addr.length - 1;
  const j = f.addr.pop()!;
  sh.child(j, k, 1, tmp);
  const [qx, qy, cx, cy] = tmp;
  const den = cx * cx + cy * cy;
  const ar = (f.ar * cx + f.ai * cy) / den;
  const ai = (f.ai * cx - f.ar * cy) / den;
  f.ar = ar;
  f.ai = ai;
  f.br -= ar * qx - ai * qy;
  f.bi -= ar * qy + ai * qx;
}

/** Move to the next (dir=1) or previous (dir=-1) segment at the same level. */
export function step(sh: Shape, f: Frame, dir: 1 | -1): boolean {
  const a = f.addr;
  const edge = dir > 0 ? 3 : 0;
  let i = a.length - 1;
  while (i >= 1 && a[i] === edge) i--;
  let rr: number, ri: number;
  if (i >= 1) {
    // ratio of child vectors at the carry level; deeper tails are c0/c3 = lo/lo = 1
    sh.child(a[i], i, 1, tmp);
    sh.child(a[i] + dir, i, 1, tmp2);
    const den = tmp[2] * tmp[2] + tmp[3] * tmp[3];
    rr = (tmp2[2] * tmp[2] + tmp2[3] * tmp[3]) / den;
    ri = (tmp2[3] * tmp[2] - tmp2[2] * tmp[3]) / den;
    a[i] += dir;
  } else {
    if (!sh.closed) return false;
    const k0 = a[0];
    const k1 = (k0 + dir + sh.nSeed) % sh.nSeed;
    const den = sh.sx[k0] ** 2 + sh.sy[k0] ** 2;
    rr = (sh.sx[k1] * sh.sx[k0] + sh.sy[k1] * sh.sy[k0]) / den;
    ri = (sh.sy[k1] * sh.sx[k0] - sh.sx[k1] * sh.sy[k0]) / den;
    a[0] = k1;
  }
  for (let m = Math.max(i, 0) + 1; m < a.length; m++) a[m] = 3 - edge;
  if (dir > 0) {
    f.br += f.ar;
    f.bi += f.ai;
  }
  const ar = f.ar * rr - f.ai * ri;
  f.ai = f.ar * ri + f.ai * rr;
  f.ar = ar;
  if (dir < 0) {
    f.br -= f.ar;
    f.bi -= f.ai;
  }
  return true;
}

function distSeg(px: number, py: number, bx: number, by: number, ax: number, ay: number) {
  const l2 = ax * ax + ay * ay;
  let t = l2 > 0 ? ((px - bx) * ax + (py - by) * ay) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - bx - ax * t, py - by - ay * t);
}

/** Re-express a level-0 frame as seed side j (same screen mapping). */
export function toSeedSide(sh: Shape, f: Frame, j: number) {
  const k0 = f.addr[0];
  if (j === k0) return;
  const den = sh.sx[k0] ** 2 + sh.sy[k0] ** 2;
  // A_j = A·(s_j/s_k0), B_j = B + A·((v_j - v_k0)/s_k0)
  const rr = (sh.sx[j] * sh.sx[k0] + sh.sy[j] * sh.sy[k0]) / den;
  const ri = (sh.sy[j] * sh.sx[k0] - sh.sx[j] * sh.sy[k0]) / den;
  const dx = sh.vx[j] - sh.vx[k0], dy = sh.vy[j] - sh.vy[k0];
  const pr = (dx * sh.sx[k0] + dy * sh.sy[k0]) / den;
  const pi = (dy * sh.sx[k0] - dx * sh.sy[k0]) / den;
  const ar = f.ar * rr - f.ai * ri, ai = f.ar * ri + f.ai * rr;
  f.br += f.ar * pr - f.ai * pi;
  f.bi += f.ar * pi + f.ai * pr;
  f.ar = ar;
  f.ai = ai;
  f.addr[0] = j;
}

/** Camera for the seed side 0 given a world→screen similarity (m·(z - c) + off). */
export function seedFrame(sh: Shape, mr: number, mi: number, cx: number, cy: number, ox: number, oy: number): Frame {
  const dx = sh.vx[0] - cx, dy = sh.vy[0] - cy;
  return {
    addr: [0],
    ar: mr * sh.sx[0] - mi * sh.sy[0],
    ai: mr * sh.sy[0] + mi * sh.sx[0],
    br: mr * dx - mi * dy + ox,
    bi: mr * dy + mi * dx + oy,
  };
}

/**
 * Branch-and-bound search for the curve segment nearest to (vx, vy), refined
 * until segments are at most `hi` px long. Subtrees are ranked by a guaranteed
 * lower bound on their distance (disc of radius |A|·rho around the midpoint)
 * and pruned once they cannot beat the best leaf found so far. Unlike a greedy
 * "closest chord" descent this cannot wander off into the wrong branch.
 */
function nearestLeaf(sh: Shape, roots: Frame[], vx: number, vy: number, hi: number): Frame | null {
  const lb = (f: Frame) => Math.hypot(vx - f.br - f.ar / 2, vy - f.bi - f.ai / 2) - Math.hypot(f.ar, f.ai) * sh.rho;
  let best: Frame | null = null, bd = Infinity;
  const stack = roots.map(cloneFrame).sort((a, b) => lb(b) - lb(a));
  for (let it = 0; it < 20000 && stack.length; it++) {
    const f = stack.pop()!;
    if (lb(f) >= bd) continue;
    if (Math.hypot(f.ar, f.ai) <= hi) {
      const d = distSeg(vx, vy, f.br, f.bi, f.ar, f.ai);
      if (d < bd) { bd = d; best = f; }
      continue;
    }
    const kids: Frame[] = [];
    for (let j = 0; j < 4; j++) {
      const g = cloneFrame(f);
      descend(sh, g, j);
      kids.push(g);
    }
    kids.sort((a, b) => lb(b) - lb(a)); // nearest ends up on top of the stack
    stack.push(...kids);
  }
  return best;
}

/**
 * The segment plus up to n neighbours either side along the curve (all seed sides at
 * level 0). Points close in space can sit in adjacent branches of the tree, so
 * nearest-point searches must start from a neighbourhood, not a single subtree.
 */
function neighbourhood(sh: Shape, f: Frame, n: number): Frame[] {
  if (f.addr.length === 1 && sh.closed) {
    const out: Frame[] = [];
    for (let j = 0; j < sh.nSeed; j++) {
      const g = cloneFrame(f);
      toSeedSide(sh, g, j);
      out.push(g);
    }
    return out;
  }
  const out = [cloneFrame(f)];
  for (const dir of [1, -1] as const) {
    let g = f;
    for (let k = 0; k < n; k++) {
      const h = cloneFrame(g);
      if (!step(sh, h, dir)) break;
      out.push(h);
      g = h;
    }
  }
  return out;
}

/**
 * Keep the camera segment screen-sized and as close as possible to the view
 * centre. Only ever climbs as high as needed, so numbers stay small (precision).
 */
export function normalize(sh: Shape, f: Frame, vcx: number, vcy: number, diag: number) {
  const hi = 2 * diag;
  const set = (g: Frame | null) => { if (g) Object.assign(f, g); };

  // too small: climb until the parent would be too small to split again
  for (let it = 0; it < 4000 && f.addr.length > 1; it++) {
    sh.child(f.addr[f.addr.length - 1], f.addr.length - 1, 1, tmp);
    if (Math.hypot(f.ar, f.ai) / Math.hypot(tmp[2], tmp[3]) >= hi / 2) break;
    ascend(sh, f);
  }

  // drifted away from the view centre (zooming around the cursor / fingers):
  // climb until the ancestor is big enough to reach back, then search it
  const d0 = distSeg(vcx, vcy, f.br, f.bi, f.ar, f.ai);
  if (d0 > diag / 2) {
    while (f.addr.length > 1 && Math.hypot(f.ar, f.ai) < 4 * d0) ascend(sh, f);
    set(nearestLeaf(sh, neighbourhood(sh, f, 3), vcx, vcy, hi));
    return;
  }

  // too big: refine to the nearest sub-segment (neighbours included: branches interleave)
  if (Math.hypot(f.ar, f.ai) > hi) set(nearestLeaf(sh, neighbourhood(sh, f, 1), vcx, vcy, hi));
}

// ─────────────────────────── builder ───────────────────────────

export interface BuildOptions {
  dpr: number;
  /** Device px. */
  width: number;
  height: number;
  /** Stop subdividing below this segment length (device px). */
  lodPx: number;
  /** Max iteration level (Infinity = unlimited). */
  maxLevel: number;
  /** Morph of the deepest level, 0..1. */
  t: number;
  fill: boolean;
  /** Extra culling margin (device px), e.g. line width. */
  pad: number;
  /** View centre in CSS px (for follow-curve). */
  vcx: number;
  vcy: number;
}

export interface BuildResult {
  /** 8 floats per segment: ax, ay, bx, by, u0, du, level, 0 (device px, y up, centred). */
  seg: Float32Array;
  segCount: number;
  /** 2 floats per vertex, 3 vertices per triangle. */
  tri: Float32Array;
  triVerts: number;
  deepest: number;
  /** Emitted segments at the depth cap that are still large on screen. */
  capped: number;
  /** Nearest curve point to the view centre (CSS px), if any. */
  nearest: [number, number] | null;
  fillCenter: [number, number];
  fillRadius: number;
  /** How much the detail cutoff was coarsened to stay within the segment budget (1 = as requested). */
  lodScale: number;
  /** A finer cutoff may fit: rebuild next frame even if the view is unchanged. */
  refine: boolean;
  ms: number;
}

/** Hard cap: past this, remaining segments are emitted unrefined. */
const BUDGET = 2_000_000;
/**
 * Soft cap. Near-space-filling shapes would emit millions of sub-pixel segments
 * that add nothing visible, so the detail cutoff is coarsened until a build
 * fits (see `lodScale`).
 */
const SOFT_BUDGET = 200_000;

export class Builder {
  private seg = new Float32Array(8 * 65536);
  private tri = new Float32Array(6 * 65536);
  /** Multiplier on the requested detail cutoff, carried between frames. */
  private lodScale = 1;
  /** Builds to wait before trying a finer cutoff again. */
  private cooldown = 0;
  /** Cutoff multiplier that last worked, while a finer one is being tried (0 = no trial). */
  private trialFrom = 0;
  /** A finer cutoff already failed for this exact view: stop trying until it changes. */
  private settled = false;
  private lastShape: Shape | null = null;
  private viewKey = '';

  build(sh: Shape, cam: Frame, o: BuildOptions): BuildResult {
    const t0 = performance.now();
    const dpr = o.dpr;
    const hw = o.width / 2, hh = o.height / 2;
    const diag = Math.hypot(o.width, o.height) / dpr;
    const big = 4 * Math.max(o.width, o.height); // clip anything beyond this
    const cw = o.width, ch = o.height; // clip rect half-extents (2× viewport)

    // ── render root ──
    const root = cloneFrame(cam);
    while (levelOf(root) > 0 && (Math.hypot(root.ar, root.ai) < 1.5 * diag || levelOf(root) > o.maxLevel - 1)) ascend(sh, root);
    if (levelOf(root) <= 4) while (levelOf(root) > 0) ascend(sh, root);

    // ── chain of root-level segments covering the view ──
    const chain: Frame[] = [];
    const visible = (f: Frame, margin: number) => {
      const rad = Math.hypot(f.ar, f.ai) * sh.rho + margin;
      const cx = f.br + f.ar / 2, cy = f.bi + f.ai / 2;
      return Math.abs(cx) < hw / dpr + rad && Math.abs(cy) < hh / dpr + rad;
    };
    let whole = false;
    let u0: number, du: number;
    if (levelOf(root) === 0) {
      whole = true;
      for (let j = 0; j < sh.nSeed; j++) {
        const g = cloneFrame(root);
        toSeedSide(sh, g, j);
        chain.push(g);
      }
      u0 = 0;
      du = 1 / sh.nSeed;
    } else {
      chain.push(root);
      for (const dir of [1, -1] as const) {
        let f = root;
        // walk until a couple of consecutive segments are off-screen (tolerates folds)
        let misses = 0;
        for (let n = 0; n < 64 && misses < 3; n++) {
          const g = cloneFrame(f);
          if (!step(sh, g, dir)) break;
          if (dir > 0) chain.push(g);
          else chain.unshift(g);
          f = g;
          misses = visible(g, diag) ? 0 : misses + 1;
        }
      }
      // global path parameter of the first chain segment
      const first = chain[0].addr;
      let u = first[0], sc = 1;
      for (let i = 1; i < first.length; i++) {
        sc /= 4;
        u += first[i] * sc;
      }
      u0 = u / sh.nSeed;
      du = sc / sh.nSeed;
    }

    // ── recursive refinement ──
    let segN = 0, triN = 0, deepest = 0, capped = 0;
    let nearD = Infinity, nearX = 0, nearY = 0;
    const vcx = o.vcx * dpr, vcy = o.vcy * dpr;
    const { lo, hi, ux, hf, rho } = sh;
    const maxLevel = o.maxLevel, mt = o.t, pad = o.pad;
    const bigCap = 40 * dpr;
    let lod = o.lodPx * this.lodScale;
    /** Give up on a pass once it emits this many segments. */
    let abortAt = Infinity;
    let over = false;

    const growSeg = () => {
      const n = new Float32Array(this.seg.length * 2);
      n.set(this.seg);
      this.seg = n;
    };
    const growTri = () => {
      const n = new Float32Array(this.tri.length * 2);
      n.set(this.tri);
      this.tri = n;
    };

    const emit = (ax: number, ay: number, bx: number, by: number, u: number, d: number, k: number) => {
      if (Math.abs(ax) > big || Math.abs(ay) > big || Math.abs(bx) > big || Math.abs(by) > big) {
        // Liang–Barsky clip in float64 so float32 never sees huge coordinates
        const dx = bx - ax, dy = by - ay;
        let t0 = 0, t1 = 1;
        const p = [-dx, dx, -dy, dy];
        const q = [ax + cw, cw - ax, ay + ch, ch - ay];
        for (let i = 0; i < 4; i++) {
          if (p[i] === 0) {
            if (q[i] < 0) return;
          } else {
            const r = q[i] / p[i];
            if (p[i] < 0) { if (r > t1) return; if (r > t0) t0 = r; }
            else { if (r < t0) return; if (r < t1) t1 = r; }
          }
        }
        const nax = ax + dx * t0, nay = ay + dy * t0;
        bx = ax + dx * t1; by = ay + dy * t1;
        ax = nax; ay = nay;
        u += d * t0;
        d *= t1 - t0;
      }
      if ((segN + 1) * 8 > this.seg.length) growSeg();
      const s = this.seg, i = segN * 8;
      s[i] = ax; s[i + 1] = ay; s[i + 2] = bx; s[i + 3] = by;
      s[i + 4] = u; s[i + 5] = d; s[i + 6] = k; s[i + 7] = 0;
      segN++;
      const dd = distSeg(vcx, vcy, ax, ay, bx - ax, by - ay);
      if (dd < nearD) {
        nearD = dd;
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
        let tt = l2 > 0 ? ((vcx - ax) * (bx - ax) + (vcy - ay) * (by - ay)) / l2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        nearX = ax + (bx - ax) * tt;
        nearY = ay + (by - ay) * tt;
      }
    };

    const pushPoly = (pts: number[]) => {
      // pts: flat [x,y,...]; clip to rect if needed, then fan-triangulate
      let p = pts;
      let needClip = false;
      for (let i = 0; i < p.length; i++) if (Math.abs(p[i]) > big) { needClip = true; break; }
      if (needClip) p = clipPoly(p, cw, ch);
      const n = p.length / 2;
      for (let i = 1; i < n - 1; i++) {
        if ((triN + 3) * 2 > this.tri.length) growTri();
        const b = this.tri, j = triN * 2;
        b[j] = p[0]; b[j + 1] = p[1];
        b[j + 2] = p[i * 2]; b[j + 3] = p[i * 2 + 1];
        b[j + 4] = p[i * 2 + 2]; b[j + 5] = p[i * 2 + 3];
        triN += 3;
      }
    };

    const fill = o.fill && sh.closed;
    const visit = (ar: number, ai: number, br: number, bi: number, k: number, u: number, d: number) => {
      if (over) return;
      if (segN >= abortAt) { over = true; return; }
      const len = Math.hypot(ar, ai);
      const rad = len * rho + pad;
      const cx = br + ar * 0.5, cy = bi + ai * 0.5;
      if (cx - rad > hw || cx + rad < -hw || cy - rad > hh || cy + rad < -hh) return;
      if (k >= maxLevel || len < lod || segN >= BUDGET) {
        if (k > deepest) deepest = k;
        if (k >= maxLevel && len > bigCap) capped++;
        emit(br, bi, br + ar, bi + ai, u, d, k);
        return;
      }
      const kk = k + 1;
      const s = hf * sh.sign(kk) * (kk === maxLevel ? mt : 1);
      const p1r = br + ar * lo, p1i = bi + ai * lo;
      const p2r = br + ar * ux + ai * s, p2i = bi + ai * ux - ar * s;
      const p3r = br + ar * hi, p3i = bi + ai * hi;
      const p4r = br + ar, p4i = bi + ai;
      if (fill && s !== 0) {
        if (Math.abs(p2r) > big || Math.abs(p2i) > big || Math.abs(p1r) > big || Math.abs(p1i) > big || Math.abs(p3r) > big || Math.abs(p3i) > big) {
          pushPoly([p1r, p1i, p2r, p2i, p3r, p3i]);
        } else {
          if ((triN + 3) * 2 > this.tri.length) growTri();
          const b = this.tri, j = triN * 2;
          b[j] = p1r; b[j + 1] = p1i; b[j + 2] = p2r; b[j + 3] = p2i; b[j + 4] = p3r; b[j + 5] = p3i;
          triN += 3;
        }
      }
      const q = d / 4;
      visit(p1r - br, p1i - bi, br, bi, kk, u, q);
      visit(p2r - p1r, p2i - p1i, p1r, p1i, kk, u + q, q);
      visit(p3r - p2r, p3i - p2i, p2r, p2i, kk, u + 2 * q, q);
      visit(p4r - p3r, p4i - p3i, p3r, p3i, kk, u + 3 * q, q);
    };

    // base polygon for the fill (even-odd parity of everything above the chain level)
    const basePts: number[] = [];
    if (fill && sh.nSeed >= 3) {
      const pts = basePts;
      for (const f of chain) pts.push(f.br * dpr, f.bi * dpr);
      if (!whole) {
        const last = chain[chain.length - 1];
        const ex = (last.br + last.ar) * dpr, ey = (last.bi + last.ai) * dpr;
        pts.push(ex, ey);
        // close the open chain far away on its left (interior) side
        let dx = ex - pts[0], dy = ey - pts[1];
        let dl = Math.hypot(dx, dy);
        if (dl < 1e-9) { dx = root.ar; dy = root.ai; dl = Math.hypot(dx, dy); }
        const far = 4 * (dl + Math.hypot(o.width, o.height));
        pts.push((pts[0] + ex) / 2 - (dy / dl) * far, (pts[1] + ey) / 2 + (dx / dl) * far);
      }
    }

    const lvl0 = levelOf(chain[0]);
    const base = o.lodPx;
    const viewKey = [cam.addr.length, cam.ar, cam.ai, cam.br, cam.bi, o.width, o.height, o.lodPx, o.maxLevel, o.t, o.fill].join();
    const sameView = sh === this.lastShape && viewKey === this.viewKey;
    this.lastShape = sh;
    this.viewKey = viewKey;
    if (!sameView) this.settled = false;
    const trial = this.trialFrom; // > 0: this build tries a finer cutoff than the last one that worked
    this.trialFrom = 0;
    let refine = false;
    for (let pass = 0; ; pass++) {
      const last = pass >= 6;
      segN = 0; triN = 0; deepest = 0; capped = 0; nearD = Infinity; over = false;
      abortAt = last ? Infinity : 2 * SOFT_BUDGET;
      if (basePts.length) pushPoly(basePts);
      chain.forEach((f, i) => visit(f.ar * dpr, f.ai * dpr, f.br * dpr, f.bi * dpr, lvl0, u0 + i * du, du));
      if (last) break;
      const scale = lod / base;
      if (over) {
        // Far too many: go back to the cutoff that worked (failed trial) or coarsen, and retry.
        if (pass === 0 && trial > scale) {
          lod = base * trial;
          if (sameView) this.settled = true;
        } else lod *= 2;
        this.cooldown = 30;
        continue;
      }
      if (segN > SOFT_BUDGET) {
        // Acceptable for this frame; coarsen the next one.
        this.lodScale = scale * Math.max(1.2, Math.sqrt(segN / SOFT_BUDGET));
        this.cooldown = 30;
      } else {
        this.lodScale = scale;
        // Headroom for finer detail? Segment count can jump ~4x at once (a whole level
        // subdividing), so only try with plenty of room, and not right after a failure.
        if (scale > 1 && segN < 0.2 * SOFT_BUDGET && !this.settled) {
          refine = true;
          if (this.cooldown > 0) this.cooldown--;
          else {
            this.trialFrom = scale;
            this.lodScale = Math.max(1, scale * Math.sqrt((4 * segN + 1) / (0.9 * SOFT_BUDGET)));
          }
        }
      }
      break;
    }

    // radial fill gradient: world origin → screen, via the seed frame
    const sf = cloneFrame(cam);
    while (levelOf(sf) > 0) ascend(sh, sf);
    const k0 = sf.addr[0];
    const den = sh.sx[k0] ** 2 + sh.sy[k0] ** 2;
    const pr = (-sh.vx[k0] * sh.sx[k0] - sh.vy[k0] * sh.sy[k0]) / den;
    const pi = (-sh.vy[k0] * sh.sx[k0] + sh.vx[k0] * sh.sy[k0]) / den;
    let fcx = (sf.br + sf.ar * pr - sf.ai * pi) * dpr;
    let fcy = (sf.bi + sf.ar * pi + sf.ai * pr) * dpr;
    let frad = (sh.radius * Math.hypot(sf.ar, sf.ai) / Math.sqrt(den)) * dpr;
    if (!Number.isFinite(fcx + fcy + frad) || frad > 1e30) {
      fcx = 0; fcy = 0; frad = 1e-9; // infinitely far: treat as "outer"
    }

    return {
      seg: this.seg,
      segCount: segN,
      tri: this.tri,
      triVerts: triN,
      deepest,
      capped,
      nearest: nearD < Infinity ? [nearX / dpr, nearY / dpr] : null,
      fillCenter: [fcx, fcy],
      fillRadius: frad,
      lodScale: lod / base,
      refine,
      ms: performance.now() - t0,
    };
  }
}

/** Sutherland–Hodgman clip of a polygon to [-cw,cw]×[-ch,ch]. */
function clipPoly(p: number[], cw: number, ch: number): number[] {
  const edges: Array<[number, number, number]> = [
    [1, 0, cw], [-1, 0, cw], [0, 1, ch], [0, -1, ch], // inside: nx*x + ny*y <= d
  ];
  let out = p;
  for (const [nx, ny, d] of edges) {
    const inp = out;
    out = [];
    const n = inp.length / 2;
    if (!n) break;
    for (let i = 0; i < n; i++) {
      const ax = inp[i * 2], ay = inp[i * 2 + 1];
      const j = (i + 1) % n;
      const bx = inp[j * 2], by = inp[j * 2 + 1];
      const da = nx * ax + ny * ay - d, db = nx * bx + ny * by - d;
      if (da <= 0) out.push(ax, ay);
      if ((da <= 0) !== (db <= 0)) {
        const t = da / (da - db);
        out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
  }
  return out;
}

/** Nearest point on the emitted segments to (x, y) (device px). Returns [x, y, distance]. */
export function nearestOnSegments(seg: Float32Array, count: number, x: number, y: number): [number, number, number] | null {
  let bd = Infinity, bx = 0, by = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    const ax = seg[o], ay = seg[o + 1];
    const dx = seg[o + 2] - ax, dy = seg[o + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, py = ay + dy * t;
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return bd < Infinity ? [bx, by, Math.sqrt(bd)] : null;
}
