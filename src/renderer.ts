import type { GeomResult } from './types';

/**
 * WebGL2 renderer built on *vertex pulling*: all points live in one RGBA32F
 * texture ([x, y, baseX, baseY] per texel) and shaders derive everything from
 * gl_VertexID. No vertex/index buffers at all.
 *
 * - Level of detail: level-k vertices sit at stride 4^(L-k) in the final data,
 *   so any coarser iteration can be drawn from the same texture. We draw the
 *   finest level whose segments are still ≥ ~1 device pixel — finer detail is
 *   invisible anyway. Zooming in automatically reveals deeper levels.
 * - Strokes: 6 vertices per segment expand into a quad; the fragment shader
 *   computes distance-to-segment for anti-aliased lines with round joins.
 * - Fill: even-odd stencil fill. The parity of the level-n curve equals the
 *   seed polygon XOR every spike triangle of every level, so we stencil-invert
 *   small local triangles instead of a huge triangle fan of slivers (which is
 *   pathologically slow to rasterise). Then one full-screen pass shades it.
 * - Morphing between iterations is a per-vertex lerp on the GPU.
 */

const COMMON = /* glsl */ `
uniform highp sampler2D u_data;
uniform int u_shift;     // log2(texture width)
uniform float u_t;
uniform vec2 u_rot;      // cos, sin
uniform vec2 u_pivot;    // world
uniform float u_scale;   // device px per world unit
uniform vec2 u_offset;   // device px
uniform vec2 u_res;      // device px

vec2 P(int i) {
  vec4 d = texelFetch(u_data, ivec2(i & ((1 << u_shift) - 1), i >> u_shift), 0);
  vec2 p = mix(d.zw, d.xy, u_t) - u_pivot;
  return vec2(p.x * u_rot.x - p.y * u_rot.y, p.x * u_rot.y + p.y * u_rot.x) * u_scale + u_offset;
}
`;

const LINE_VS = /* glsl */ `#version 300 es
${COMMON}
uniform int u_stride;    // index stride for the drawn LOD level
uniform float u_count;   // segments drawn
uniform float u_hw;      // half line width, device px

out vec2 v_local;
flat out float v_len;
out float v_t;

void main() {
  int s = gl_VertexID / 6;
  int k = gl_VertexID - s * 6;
  // two triangles: (0,-) (1,-) (0,+) | (0,+) (1,-) (1,+)
  float along = (k == 1 || k == 4 || k == 5) ? 1.0 : 0.0;
  float side = (k == 2 || k == 3 || k == 5) ? 1.0 : -1.0;

  vec2 A = P(s * u_stride);
  vec2 B = P((s + 1) * u_stride);
  vec2 d = B - A;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u_hw + 1.0;
  vec2 pos = mix(A - dir * r, B + dir * r, along) + nrm * side * r;
  v_local = vec2(mix(-r, len + r, along), side * r);
  v_len = len;
  v_t = (float(s) + along) / u_count;
  gl_Position = vec4(pos * 2.0 / u_res, 0.0, 1.0);
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_len;
in float v_t;

uniform float u_hw;
uniform int u_mode;      // 0 solid, 1 gradient, 2 rainbow
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform float u_cycles;
uniform float u_phase;
uniform float u_alpha;

out vec4 o;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  float dx = v_local.x - clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(dx, v_local.y));
  float hw = max(u_hw, 0.5);
  float a = clamp(hw + 0.5 - dist, 0.0, 1.0) * min(1.0, u_hw * 2.0);
  if (a <= 0.0) discard;

  float t = v_t * u_cycles + u_phase;
  vec3 c;
  if (u_mode == 0) c = u_c0;
  else if (u_mode == 1) c = mix(u_c0, u_c1, 1.0 - abs(fract(t) * 2.0 - 1.0));
  else c = hsv2rgb(vec3(fract(t), 0.65, 1.0));
  o = vec4(c * a * u_alpha, a * u_alpha); // premultiplied
}`;

const FILL_VS = /* glsl */ `#version 300 es
${COMMON}
uniform int u_level;     // generated level L
uniform int u_sides;

void main() {
  int tri = gl_VertexID / 3;
  int corner = gl_VertexID - tri * 3;
  int fanN = max(u_sides - 2, 0);
  int idx;
  if (tri < fanN) {
    // seed polygon as a small fan of its own vertices
    int S0 = 1 << (2 * u_level);
    idx = corner == 0 ? 0 : (tri + corner) * S0;
  } else {
    // spike triangle (p1, apex, p2) of level k, parent segment j
    int j = tri - fanN;
    int block = u_sides;
    int k = 1;
    for (int q = 0; q < 12; q++) {
      if (j < block || k >= u_level) break;
      j -= block;
      block *= 4;
      k++;
    }
    int stride = 1 << (2 * (u_level - k));
    idx = (4 * j + 1 + corner) * stride;
  }
  gl_Position = vec4(P(idx) * 2.0 / u_res, 0.0, 1.0);
}`;

const FILL_FS = /* glsl */ `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`;

const COVER_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const COVER_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform vec2 u_center;   // device px, gradient centre
uniform float u_radius;  // device px
uniform int u_mode;      // 0 solid, 1 radial
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform float u_alpha;
out vec4 o;
void main() {
  vec3 c = u_c0;
  if (u_mode == 1) {
    float d = length(gl_FragCoord.xy - u_res * 0.5 - u_center) / u_radius;
    c = mix(u_c0, u_c1, smoothstep(0.0, 1.0, d));
  }
  o = vec4(c * u_alpha, u_alpha);
}`;

type Program = { prog: WebGLProgram; u: Record<string, WebGLUniformLocation> };

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  const u: Record<string, WebGLUniformLocation> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i)!.name;
    u[name] = gl.getUniformLocation(prog, name)!;
  }
  return { prog, u };
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface Frame {
  /** Morph factor of the newest iteration, 0..1. */
  t: number;
  rotation: number; // radians
  scale: number; // device px per world unit
  offset: [number, number]; // device px from canvas centre, y up
  pivot: [number, number];
  bg: string;
  stroke: boolean;
  lineWidth: number; // device px
  colorMode: number;
  color1: string;
  color2: string;
  cycles: number;
  phase: number;
  additive: boolean;
  strokeAlpha: number;
  fill: boolean;
  fillMode: number;
  fill1: string;
  fill2: string;
  fillAlpha: number;
  fillRadius: number; // world units
  /** Draw segments down to this many device px before switching to a coarser level. */
  lodPx: number;
}

/** Device px a segment must be before we stop drawing finer levels. */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private line: Program;
  private fill: Program;
  private cover: Program;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture | null = null;
  private texRows = 0;
  private readonly shift: number;
  private geom: GeomResult | null = null;
  /** Level actually drawn last frame (for stats). */
  drawnLevel = 0;
  drawnSegments = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      stencil: true,
      alpha: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');
    this.gl = gl;
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.fill = compile(gl, FILL_VS, FILL_FS);
    this.cover = compile(gl, COVER_VS, COVER_FS);
    this.vao = gl.createVertexArray()!; // empty: everything is pulled from the texture
    this.shift = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) >= 4096 ? 12 : 11;
  }

  upload(g: GeomResult) {
    const gl = this.gl;
    const W = 1 << this.shift;
    const rows = Math.ceil(g.points / W);
    if (!this.tex || rows > this.texRows) {
      if (this.tex) gl.deleteTexture(this.tex);
      // grow to the next power of two rows so scrubbing depth rarely reallocates
      this.texRows = Math.min(1 << Math.ceil(Math.log2(rows)), 1 << this.shift);
      this.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, this.texRows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const full = Math.floor(g.points / W);
    if (full > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, full, gl.RGBA, gl.FLOAT, g.data, 0);
    const rest = g.points - full * W;
    if (rest > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rest, 1, gl.RGBA, gl.FLOAT, g.data, full * W * 4);
    this.geom = g;
  }

  resize(dpr: number): boolean {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  private setCommon(p: Program, f: Frame, rot: [number, number], t: number) {
    const gl = this.gl;
    const u = p.u;
    gl.uniform1i(u.u_data, 0);
    gl.uniform1i(u.u_shift, this.shift);
    gl.uniform1f(u.u_t, t);
    gl.uniform2fv(u.u_rot, rot);
    gl.uniform2fv(u.u_pivot, f.pivot);
    gl.uniform1f(u.u_scale, f.scale);
    gl.uniform2fv(u.u_offset, f.offset);
    gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
  }

  draw(f: Frame) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    const [br, bg, bb] = hexToRgb(f.bg);
    gl.clearColor(br, bg, bb, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    const g = this.geom;
    if (!g || !this.tex) return;

    // ── level of detail ──
    const L = g.params.level;
    let D = L;
    for (let k = 0; k <= L; k++) {
      if (g.levelLen[k] * f.scale < f.lodPx) { D = k; break; }
    }
    // When skipping the newest level its morph is irrelevant; finer levels stay put.
    const t = D === L ? f.t : 1;
    const seedSegs = g.closed ? g.params.sides : 1;
    const segs = seedSegs * 4 ** D;
    const stride = 4 ** (L - D);
    this.drawnLevel = D;
    this.drawnSegments = segs;

    const rot: [number, number] = [Math.cos(f.rotation), Math.sin(f.rotation)];
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    if (f.fill && g.closed && f.fillAlpha > 0) {
      // 1. stencil: invert under seed polygon + every spike triangle up to level D
      gl.useProgram(this.fill.prog);
      this.setCommon(this.fill, f, rot, t);
      gl.uniform1i(this.fill.u.u_level, L);
      gl.uniform1i(this.fill.u.u_sides, g.params.sides);
      gl.enable(gl.STENCIL_TEST);
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.stencilMask(0x01);
      const tris = Math.max(g.params.sides - 2, 0) + (g.params.sides * (4 ** D - 1)) / 3;
      gl.drawArrays(gl.TRIANGLES, 0, tris * 3);

      // 2. cover: shade where parity is odd
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 0x01);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.cover.prog);
      const c = this.cover.u;
      gl.uniform2f(c.u_res, W, H);
      gl.uniform2fv(c.u_center, f.offset);
      gl.uniform1f(c.u_radius, Math.max(1, f.fillRadius * f.scale));
      gl.uniform1i(c.u_mode, f.fillMode);
      gl.uniform3fv(c.u_c0, hexToRgb(f.fill1));
      gl.uniform3fv(c.u_c1, hexToRgb(f.fill2));
      gl.uniform1f(c.u_alpha, f.fillAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.STENCIL_TEST);
    }

    if (f.stroke && f.lineWidth > 0) {
      gl.enable(gl.BLEND);
      if (f.additive) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.line.prog);
      const u = this.line.u;
      this.setCommon(this.line, f, rot, t);
      gl.uniform1i(u.u_stride, stride);
      gl.uniform1f(u.u_count, segs);
      gl.uniform1f(u.u_hw, f.lineWidth / 2);
      gl.uniform1i(u.u_mode, f.colorMode);
      gl.uniform3fv(u.u_c0, hexToRgb(f.color1));
      gl.uniform3fv(u.u_c1, hexToRgb(f.color2));
      gl.uniform1f(u.u_cycles, f.cycles);
      gl.uniform1f(u.u_phase, f.phase);
      gl.uniform1f(u.u_alpha, f.strokeAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, segs * 6);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
