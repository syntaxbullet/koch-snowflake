/**
 * WebGL2 renderer for screen-space geometry produced by the Builder.
 *
 * - Strokes use vertex pulling: segments live in an RGBA32F texture (2 texels
 *   each: endpoints, then path parameter), and 6 vertices per segment expand into
 *   a quad. The fragment shader computes the distance to the segment for
 *   anti-aliased lines of any width with round joins.
 * - Fill: even-odd stencil. Triangles invert the stencil, then a full-screen
 *   pass shades where the parity is odd.
 */

const LINE_VS = /* glsl */ `#version 300 es
uniform highp sampler2D u_data;
uniform int u_shift;
uniform vec2 u_res;
uniform float u_hw;
uniform int u_by;        // 0 = path, 1 = direction
uniform float u_theta;   // view rotation (radians), removed for direction colouring

out vec2 v_local;
flat out float v_len;
out float v_t;

vec4 T(int i) { return texelFetch(u_data, ivec2(i & ((1 << u_shift) - 1), i >> u_shift), 0); }

void main() {
  int s = gl_VertexID / 6;
  int k = gl_VertexID - s * 6;
  float along = (k == 1 || k == 4 || k == 5) ? 1.0 : 0.0;
  float side = (k == 2 || k == 3 || k == 5) ? 1.0 : -1.0;
  vec4 seg = T(2 * s);
  vec4 par = T(2 * s + 1);
  vec2 A = seg.xy, B = seg.zw;
  vec2 d = B - A;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u_hw + 1.0;
  vec2 pos = mix(A - dir * r, B + dir * r, along) + nrm * side * r;
  v_local = vec2(mix(-r, len + r, along), side * r);
  v_len = len;
  v_t = u_by == 0 ? par.x + par.y * along : (atan(d.y, d.x) - u_theta) / 6.28318530718;
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
layout(location = 0) in vec2 a_p;
uniform vec2 u_res;
void main() { gl_Position = vec4(a_p * 2.0 / u_res, 0.0, 1.0); }`;

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
uniform vec2 u_center;   // device px from canvas centre
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

export interface Style {
  bg: string;
  stroke: boolean;
  lineWidth: number; // device px
  colorMode: number;
  colorBy: number;
  theta: number;
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
  fillCenter: [number, number];
  fillRadius: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private line: Program;
  private fill: Program;
  private cover: Program;
  private emptyVao: WebGLVertexArrayObject;
  private fillVao: WebGLVertexArrayObject;
  private fillBuf: WebGLBuffer;
  private fillCap = 0;
  private tex: WebGLTexture | null = null;
  private texRows = 0;
  private readonly shift: number;
  private segCount = 0;
  private triVerts = 0;

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
    this.shift = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) >= 4096 ? 12 : 11;
    this.emptyVao = gl.createVertexArray()!;
    this.fillBuf = gl.createBuffer()!;
    this.fillVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** seg: 8 floats per segment; tri: 2 floats per vertex. */
  setGeometry(seg: Float32Array, segCount: number, tri: Float32Array, triVerts: number) {
    const gl = this.gl;
    const W = 1 << this.shift;
    const texels = segCount * 2;
    const rows = Math.max(1, Math.ceil(texels / W));
    if (!this.tex || rows > this.texRows) {
      if (this.tex) gl.deleteTexture(this.tex);
      this.texRows = Math.min(1 << Math.ceil(Math.log2(rows)), 1 << this.shift);
      this.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, this.texRows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const full = Math.floor(texels / W);
    if (full > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, full, gl.RGBA, gl.FLOAT, seg, 0);
    const rest = texels - full * W;
    if (rest > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rest, 1, gl.RGBA, gl.FLOAT, seg, full * W * 4);
    this.segCount = segCount;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    const bytes = triVerts * 8;
    if (bytes > this.fillCap) {
      this.fillCap = Math.max(bytes, this.fillCap * 2, 1 << 16);
      gl.bufferData(gl.ARRAY_BUFFER, this.fillCap, gl.DYNAMIC_DRAW);
    }
    if (triVerts) gl.bufferSubData(gl.ARRAY_BUFFER, 0, tri, 0, triVerts * 2);
    this.triVerts = triVerts;
  }

  resize(dpr: number): boolean {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  draw(f: Style) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    const [br, bg, bb] = hexToRgb(f.bg);
    gl.clearColor(br, bg, bb, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (f.fill && f.fillAlpha > 0 && this.triVerts > 0) {
      gl.useProgram(this.fill.prog);
      gl.uniform2f(this.fill.u.u_res, W, H);
      gl.enable(gl.STENCIL_TEST);
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.stencilMask(0x01);
      gl.bindVertexArray(this.fillVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triVerts);

      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 0x01);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.cover.prog);
      const c = this.cover.u;
      gl.uniform2f(c.u_res, W, H);
      gl.uniform2fv(c.u_center, f.fillCenter);
      gl.uniform1f(c.u_radius, Math.max(1e-9, f.fillRadius));
      gl.uniform1i(c.u_mode, f.fillMode);
      gl.uniform3fv(c.u_c0, hexToRgb(f.fill1));
      gl.uniform3fv(c.u_c1, hexToRgb(f.fill2));
      gl.uniform1f(c.u_alpha, f.fillAlpha);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.STENCIL_TEST);
    }

    if (f.stroke && f.lineWidth > 0 && this.segCount > 0 && this.tex) {
      gl.enable(gl.BLEND);
      if (f.additive) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.line.prog);
      const u = this.line.u;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(u.u_data, 0);
      gl.uniform1i(u.u_shift, this.shift);
      gl.uniform2f(u.u_res, W, H);
      gl.uniform1f(u.u_hw, f.lineWidth / 2);
      gl.uniform1i(u.u_by, f.colorBy);
      gl.uniform1f(u.u_theta, f.theta);
      gl.uniform1i(u.u_mode, f.colorMode);
      gl.uniform3fv(u.u_c0, hexToRgb(f.color1));
      gl.uniform3fv(u.u_c1, hexToRgb(f.color2));
      gl.uniform1f(u.u_cycles, f.cycles);
      gl.uniform1f(u.u_phase, f.phase);
      gl.uniform1f(u.u_alpha, f.strokeAlpha);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.segCount * 6);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
