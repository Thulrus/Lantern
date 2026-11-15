// The renderer (spec §9): drawFrame(timeline, t) as a pure function of show time. Each slide is
// two depth-displaced grid meshes seen through the shared camera model: a background layer (the
// photo, with the plate showing through the hole behind the subject) and a subject layer with the
// matte as its alpha, over a blurred letterbox fill. Slides render into multisampled offscreen
// targets that also carry their screen-space depth, so transitions can be depth-aware. No wall
// clock, no Math.random in drawing: every frame is a pure function of show time.
import { type Border, type V3, border, cameraFor, clampView, fitView, focusAt, liveBounds } from "$lib/planner/camera";
import type { RenderSlide, Timeline, TransitionId } from "$lib/planner/types";
import { smooth } from "$lib/util/math";
import { hash32 } from "$lib/util/prng";
import { renderText, titleAnim } from "./captions";
import { link, texture, uniforms, type TexSource } from "./gl";

const GRID_FULL = 128, GRID_LITE = 64;   // spec §9.2
const D_MIN = -0.25, D_MAX = 1.5, Z_FAR = 0.25;
const MAX_BLUR = 4.0;
const TIGHT_FROM = 0.015, TIGHT_SPAN = 0.05; // camera offset over which the subject alpha goes from grown to tight
const SAMPLES = 4;

const MESH_VS = `#version 300 es
in vec2 a_uv;
uniform sampler2D u_maps;   // R = background depth, G = subject depth, B = grown alpha, A = tight alpha
uniform float u_layer;      // 0 = background, 1 = subject
uniform float u_ia;
uniform vec3 u_cam;
uniform mat3 u_rot;
uniform vec3 u_proj;        // f, pivot inverse depth, depth scale
uniform vec3 u_view;
uniform vec2 u_canvas;      // viewport size in pixels
uniform float u_flat;       // 1 = no maps: everything at the pivot depth
out vec2 v_uv;
out float v_d;
void main() {
  vec4 m = textureLod(u_maps, a_uv, 0.0);
  float d = mix(mix(m.r, m.g, u_layer), u_proj.y, u_flat);
  vec2 p = vec2((a_uv.x - 0.5) * u_ia, a_uv.y - 0.5);
  float dd = clamp(u_proj.y + u_proj.z * (d - u_proj.y), ${D_MIN.toFixed(2)}, ${D_MAX.toFixed(2)});
  float z = 1.0 / (${Z_FAR.toFixed(2)} + (1.0 - ${Z_FAR.toFixed(2)}) * dd);
  vec3 P = vec3(p * z, z);
  vec3 c = u_rot * (P - u_cam);
  vec2 s = u_proj.x * c.xy / c.z;
  vec2 px = (s - u_view.xy) / u_view.z * u_canvas.y + 0.5 * u_canvas;
  gl_Position = vec4(px.x / u_canvas.x * 2.0 - 1.0, 1.0 - px.y / u_canvas.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
  v_d = dd;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_d;
uniform sampler2D u_tex, u_maps, u_plate;
uniform float u_layer, u_flat, u_tight, u_hasPlate;
uniform vec2 u_focus;       // inverse depth in focus, blur per unit of depth difference
uniform float u_alpha;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 o_d;   // screen-space depth of what was drawn (for depth-aware transitions)
void main() {
  vec4 m = texture(u_maps, v_uv);
  float d = mix(mix(m.r, m.g, u_layer), 0.5, u_flat);
  float bias = min(abs(d - u_focus.x) * u_focus.y, ${MAX_BLUR.toFixed(1)});
  vec3 c = texture(u_tex, v_uv, bias).rgb;
  if (u_hasPlate > 0.5 && u_layer < 0.5) {
    vec4 pl = texture(u_plate, v_uv);
    c = mix(c, pl.rgb, pl.a);
  }
  float a = mix(1.0, mix(m.b, m.a, u_tight), u_layer * (1.0 - u_flat));
  o = vec4(c, a * u_alpha);
  o_d = vec4(vec3(clamp(v_d, 0.0, 1.0)), a * u_alpha);
}`;

const SCREEN_VS = `#version 300 es
in vec2 a_uv;
uniform vec4 u_map;
out vec2 v_uv;
void main() { gl_Position = vec4(a_uv * 2.0 - 1.0, 0.0, 1.0); v_uv = a_uv * u_map.xy + u_map.zw; }`;

const SCREEN_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_p;           // mip level, dim, alpha
out vec4 o;
void main() { o = vec4(textureLod(u_tex, v_uv, u_p.x).rgb * u_p.y, u_p.z); }`;

// Composite: A (outgoing) and B (incoming) targets with their depths, the transition and captions.
const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a, u_b, u_da, u_db, u_cap;
uniform vec4 u_tr;          // mode, progress, direction, extra
uniform vec4 u_capp;        // caption alpha, dy, has caption, unused
out vec4 o;
vec3 blurTap(sampler2D s, vec2 uv, vec2 dir, float amt) {
  vec3 c = vec3(0.0);
  for (int i = -4; i <= 4; i++) c += texture(s, uv + dir * float(i) * amt / 4.0).rgb;
  return c / 9.0;
}
vec2 zoomUv(vec2 uv, float z) { return (uv - 0.5) / z + 0.5; }
void main() {
  vec2 uv = v_uv;
  int mode = int(u_tr.x + 0.5);
  float p = u_tr.y, dir = u_tr.z;
  vec3 c;
  if (mode == 0) c = texture(u_a, uv).rgb;
  else if (mode == 1) c = mix(texture(u_a, uv).rgb, texture(u_b, uv).rgb, p);                       // crossfade
  else if (mode == 2 || mode == 3) {                                                                  // dip to black / white
    float e = smoothstep(0.0, 1.0, p);
    vec3 col = mode == 2 ? vec3(0.0) : vec3(1.0);
    c = e < 0.5 ? mix(texture(u_a, uv).rgb, col, e * 2.0) : mix(col, texture(u_b, uv).rgb, (e - 0.5) * 2.0);
  } else if (mode == 4) {                                                                             // push
    float e = smoothstep(0.0, 1.0, p);
    float ax = uv.x - dir * e;
    c = (ax >= 0.0 && ax <= 1.0) ? texture(u_a, vec2(ax, uv.y)).rgb : texture(u_b, vec2(ax - dir, uv.y)).rgb;
  } else if (mode == 5) {                                                                             // whip
    float e = smoothstep(0.0, 1.0, p);
    float amt = sin(e * 3.14159) * 0.12;
    vec2 off = vec2(dir * e * 0.5, 0.0);
    vec3 a = blurTap(u_a, clamp(uv - off, 0.0, 1.0), vec2(1.0, 0.0), amt);
    vec3 b = blurTap(u_b, clamp(uv + vec2(dir * 0.5, 0.0) - off, 0.0, 1.0), vec2(1.0, 0.0), amt);
    c = mix(a, b, smoothstep(0.35, 0.65, e));
  } else if (mode == 7) {                                                                             // depth wipe: B arrives far plane first, subject last
    float f = 0.08;
    vec4 db = texture(u_db, uv);
    float nb = db.r;
    float e = mix(-f, 1.0 + f, p);                     // starts below the nearest plane so frame one is all A (it used to start at 0 and pop the far plane in)
    // Only B's photo pixels wipe by depth (alpha = mesh coverage). Its letterbox bars and split
    // gutters have no depth; wiping them as the far plane cut A to B's shape on the first frames
    // (owner, 2026-11-14), so they fade in late, after most of the photo has arrived.
    float w = mix(smoothstep(0.35, 1.0, p), smoothstep(nb - f, nb + f, e), db.a);
    c = mix(texture(u_a, uv).rgb, texture(u_b, uv).rgb, w);
  } else if (mode == 8) {                                                                             // fly-through: A zooms in and its planes pass the camera nearest first; B settles behind
    float e = p;
    float za = 1.0 + 0.7 * e * e, zb = mix(1.08, 1.0, smoothstep(0.0, 1.0, e));
    vec2 ua = zoomUv(uv, za), ub = zoomUv(uv, zb);
    float na = texture(u_da, ua).r;
    float tv = 0.3 + 0.55 * (1.0 - na);                 // when a plane at this nearness passes the camera
    float wa = 1.0 - smoothstep(tv - 0.08, tv + 0.08, e);
    vec3 a = texture(u_a, ua).rgb;
    vec3 b = texture(u_b, ub).rgb * mix(0.7, 1.0, smoothstep(0.0, 0.7, e));
    c = mix(b, a, wa);
  } else c = texture(u_b, uv).rgb;
  if (u_tr.w > 0.5) c = u_tr.w > 1.5 ? texture(u_da, uv).rrr : texture(u_db, uv).rrr;   // debug: show a target's depth
  if (u_capp.z > 0.5) {
    vec4 cap = texture(u_cap, vec2(uv.x, 1.0 - uv.y + u_capp.y));
    c = mix(c, cap.rgb, cap.a * u_capp.x);
  }
  o = vec4(c, 1.0);
}`;

const TR_MODE: Partial<Record<TransitionId, number>> = { crossfade: 1, dipBlack: 2, dipWhite: 3, push: 4, whip: 5, depthWipe: 7, flyThrough: 8, matchCut: 1, morph: 1 };

type Canvas = HTMLCanvasElement | OffscreenCanvas;

interface Target {
  ms: WebGLFramebuffer | null;                 // multisampled draw target (null when MSAA is unavailable)
  rb: WebGLRenderbuffer[];                     // its two colour renderbuffers
  fbo: WebGLFramebuffer;                       // single-sample target holding tex + dtex (draw target without MSAA, resolve target with)
  resolveD: WebGLFramebuffer;                  // dtex alone at attachment 0, for the second blit
  tex: WebGLTexture; dtex: WebGLTexture;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private textures = new Map<string, { tex: WebGLTexture; w: number; h: number; mips: boolean }>();
  private mesh: WebGLProgram; private screen: WebGLProgram; private comp: WebGLProgram;
  private mloc: Record<string, WebGLUniformLocation | null>; private sloc: Record<string, WebGLUniformLocation | null>; private cloc: Record<string, WebGLUniformLocation | null>;
  private gridVao: WebGLVertexArrayObject; private count: number;
  private quadVao: WebGLVertexArrayObject; private quadVaoC: WebGLVertexArrayObject;
  private flat: WebGLTexture;
  private targets: Target[] = [];
  private targetSize = "";
  private samples: number;
  private capTex: WebGLTexture;
  private capKey = "";
  private borders = new Map<string, Border>();
  lite = false;
  /** Debug: 1 shows the incoming target's depth, 2 the outgoing's (frame dumps only). */
  debug = 0;

  constructor(public canvas: Canvas, opts: { lite?: boolean; preserve?: boolean } = {}) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserve, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.lite = !!opts.lite;
    this.samples = Math.min(SAMPLES, gl.getParameter(gl.MAX_SAMPLES) as number);
    this.mesh = link(gl, MESH_VS, MESH_FS);
    this.mloc = uniforms(gl, this.mesh, ["u_maps", "u_tex", "u_plate", "u_layer", "u_ia", "u_cam", "u_rot", "u_proj", "u_view", "u_canvas", "u_flat", "u_tight", "u_hasPlate", "u_focus", "u_alpha"]);
    this.screen = link(gl, SCREEN_VS, SCREEN_FS);
    this.sloc = uniforms(gl, this.screen, ["u_map", "u_tex", "u_p"]);
    this.comp = link(gl, SCREEN_VS, COMP_FS);
    this.cloc = uniforms(gl, this.comp, ["u_map", "u_a", "u_b", "u_da", "u_db", "u_cap", "u_tr", "u_capp"]);

    const G = this.lite ? GRID_LITE : GRID_FULL;
    const uv: number[] = [], idx: number[] = [];
    for (let y = 0; y <= G; y++) for (let x = 0; x <= G; x++) uv.push(x / G, y / G);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const a = y * (G + 1) + x, b = a + 1, c = a + G + 1, d = c + 1;
        // Alternate the diagonal so silhouettes do not take on one stair direction.
        if ((x + y) % 2) idx.push(a, b, c, b, d, c); else idx.push(a, b, d, a, d, c);
      }
    this.count = idx.length;
    this.gridVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(this.mesh, "a_uv");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);

    const quad = (prog: WebGLProgram) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const q = gl.getAttribLocation(prog, "a_uv");
      gl.enableVertexAttribArray(q);
      gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 0, 0);
      return vao;
    };
    this.quadVao = quad(this.screen);
    this.quadVaoC = quad(this.comp);
    gl.bindVertexArray(null);

    this.flat = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.flat);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.capTex = gl.createTexture()!;
    for (let i = 0; i < 2; i++) {
      this.targets.push({
        ms: this.samples > 0 ? gl.createFramebuffer()! : null, rb: this.samples > 0 ? [gl.createRenderbuffer()!, gl.createRenderbuffer()!] : [],
        fbo: gl.createFramebuffer()!, resolveD: gl.createFramebuffer()!, tex: gl.createTexture()!, dtex: gl.createTexture()!,
      });
    }
  }

  has(key: string): boolean { return this.textures.has(key); }
  keys(): string[] { return [...this.textures.keys()]; }

  upload(key: string, src: TexSource, mips = true): void {
    const old = this.textures.get(key);
    const w = "width" in src ? (src as { width: number }).width : (src as VideoFrame).displayWidth;
    const h = "height" in src ? (src as { height: number }).height : (src as VideoFrame).displayHeight;
    const tex = texture(this.gl, src, mips, old?.tex ?? null);
    this.textures.set(key, { tex, w, h, mips });
  }

  /** The maps texture for a photo: RGBA floats (see layers.ts composeMaps), kept at half precision. */
  uploadMaps(key: string, data: Float32Array, w: number, h: number): void {
    const gl = this.gl;
    const old = this.textures.get(key);
    const tex = old?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.textures.set(key, { tex, w, h, mips: false });
  }

  drop(key: string): void {
    const t = this.textures.get(key);
    if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(key); }
  }

  /** (Re)build the offscreen targets for the canvas size and bind target i for drawing. */
  private target(i: number): void {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height, key = `${w}x${h}`;
    if (this.targetSize !== key) {
      for (const t of this.targets) {
        for (const tex of [t.tex, t.dtex]) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t.dtex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.resolveD);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.dtex, 0);
        if (t.ms) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.ms);
          t.rb.forEach((rb, k) => {
            gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.RENDERBUFFER, rb);
          });
        }
      }
      this.targetSize = key;
    }
    const t = this.targets[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.ms ?? t.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, w, h);
  }

  /** Clear the bound target: colour to black, the depth attachment to far with zero coverage
   *  (its alpha says where a photo mesh was drawn; letterbox fills and gutters leave it 0). */
  private clearTarget(): void {
    const gl = this.gl;
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
  }

  /** Resolve a multisampled target into its textures (no-op without MSAA). */
  private resolve(i: number): void {
    const gl = this.gl, t = this.targets[i];
    if (!t.ms) return;
    const w = this.canvas.width, h = this.canvas.height;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.ms);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.resolveD);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Layers visible at t: at most the outgoing and the incoming slide. */
  static activeLayers(tl: Timeline, t: number): RenderSlide[] {
    const act = tl.layers.filter((l) => t >= l.t0 && t < l.t1);
    if (!act.length && tl.layers.length) {
      const last = tl.layers[tl.layers.length - 1];
      if (t >= last.t1) return [last];
      return [tl.layers[0]];
    }
    act.sort((a, b) => a.t0 - b.t0);
    return act.slice(-2);
  }

  /** Draw the frame at show time t. */
  draw(tl: Timeline, t: number): void {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const act = Renderer.activeLayers(tl, t);
    const a = act.length === 2 ? act[0] : null, b = act.length === 2 ? act[1] : act[0] ?? null;
    // Which transition is in progress (B arriving over A)?
    let mode = 0, p = 0, dir = 1;
    if (a && b && b.enter && b.enter.type !== "cut" && t < b.enter.t1) {
      mode = TR_MODE[b.enter.type] ?? 1;
      p = smooth((t - b.enter.t0) / Math.max(b.enter.t1 - b.enter.t0, 1e-6));
      dir = hash32(b.id) % 2 ? 1 : -1;
    }
    const soloB = !a || mode === 0;
    // Render the incoming slide into target 1 and the outgoing into target 0.
    this.target(1);
    gl.disable(gl.SCISSOR_TEST);
    this.clearTarget();
    if (b) this.slide(b, t, [0, 0, W, H]);
    this.resolve(1);
    if (!soloB && a) { this.target(0); this.clearTarget(); this.slide(a, t, [0, 0, W, H]); this.resolve(0); }
    // Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.comp);
    gl.bindVertexArray(this.quadVaoC);
    const [ta, tb] = this.targets;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ta.tex); gl.uniform1i(this.cloc.u_a, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tb.tex); gl.uniform1i(this.cloc.u_b, 1);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, ta.dtex); gl.uniform1i(this.cloc.u_da, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tb.dtex); gl.uniform1i(this.cloc.u_db, 4);
    gl.uniform4f(this.cloc.u_map, 1, 1, 0, 0);
    gl.uniform4f(this.cloc.u_tr, soloB ? 6 : mode, p, dir, this.debug);
    // Captions and titles.
    const cap = this.captionAt(tl, t, W, H);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.capTex); gl.uniform1i(this.cloc.u_cap, 2);
    gl.uniform4f(this.cloc.u_capp, cap?.alpha ?? 0, cap?.dy ?? 0, cap ? 1 : 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private captionAt(tl: Timeline, t: number, W: number, H: number): { alpha: number; dy: number } | null {
    const act = Renderer.activeLayers(tl, t);
    const title = act.reverse().find((l) => l.title && t >= l.t0 && t < l.t1);
    let key = "", alpha = 0, dy = 0, text = "", style: "plain" | "title" | "chapter" = "plain", position: "bottom" | "center" | "top" = "bottom";
    if (title?.title) {
      const x = (t - title.t0) / Math.max(title.t1 - title.t0, 1e-6);
      const an = titleAnim(title.title.animation, x, title.t1 - title.t0);
      alpha = an.alpha; dy = an.dy; text = title.title.text; style = "title"; position = "center";
      key = `t|${title.id}`;
    } else {
      const c = tl.captions.find((c) => t >= c.t0 && t < c.t1);
      if (!c) return null;
      const fade = 0.4;
      alpha = smooth(Math.min((t - c.t0) / fade, (c.t1 - t) / fade, 1));
      text = c.text; style = c.style; position = c.position; key = `c|${c.slideId}|${c.text}`;
    }
    if (!text) return null;
    const tex = renderText(text, style, position, W, H);
    const k = `${key}|${W}x${H}`;
    if (k !== this.capKey) { texture(this.gl, tex.canvas, false, this.capTex); this.capKey = k; }
    return { alpha, dy };
  }

  private borderFor(s: RenderSlide): Border {
    const key = s.edge ? `${s.id}|${s.w}x${s.h}` : `${s.w}x${s.h}`;
    let b = this.borders.get(key);
    if (!b) {
      b = border(s.w / s.h, null);
      if (s.edge && s.edge.length === b.u.length) { b.bg = s.edge; b.fig = s.edge; }
      this.borders.set(key, b);
    }
    return b;
  }

  /** Camera and framing for a slide at show time t, inside a viewport of aspect cw/ch. */
  frame(s: RenderSlide, t: number, cw: number, ch: number): { view: V3; cam: ReturnType<typeof cameraFor>; focus: [number, number] } {
    const x = warpedProgress(t, s.t0, s.t1, s.accents);
    const cam = cameraFor(s.keys, x, s.aim, s.k ?? 0, s.pivot ?? 0.5);
    let view: V3 = cam.view;
    const aspect = cw / ch;
    const live = liveBounds(cam, s.pivot ?? 0.5, this.borderFor(s));
    view = s.cover ? fitView(view, live, aspect, s.cover) : s.bounds ? clampView(view, s.bounds, aspect) : view;
    return { view, cam, focus: focusAt(s.focus, x) };
  }

  /** One slide into the current target, inside rect (x, y, w, h in pixels). */
  private slide(s: RenderSlide, t: number, rect: [number, number, number, number]): void {
    const gl = this.gl;
    if (s.cells) {
      const [rx, ry, rw, rh] = rect;
      for (const c of s.cells) {
        const r: [number, number, number, number] = [Math.round(rx + c.rect[0] * rw), Math.round(ry + c.rect[1] * rh), Math.round(c.rect[2] * rw), Math.round(c.rect[3] * rh)];
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(r[0], this.canvas.height - r[1] - r[3], r[2], r[3]);
        this.slide(c.slide, t, r);
        gl.disable(gl.SCISSOR_TEST);
      }
      return;
    }
    if (s.title) return; // title cards: black with text from the composite pass
    const key = s.assets.video ? "v:" + s.assets.video.hash : s.assets.image ? s.assets.image.hash : null;
    const tex = key ? this.textures.get(key) ?? (s.assets.image ? this.textures.get(s.assets.image.hash) : undefined) : undefined;
    if (!tex) { this.placeholder(rect); return; }
    const [rx, ry, cw, ch] = rect;
    // GL viewport is bottom-left based; our rects are top-left based.
    gl.viewport(rx, this.canvas.height - ry - ch, cw, ch);
    const { view, cam, focus } = this.frame(s, t, cw, ch);
    // Letterbox fill: the photo cover-fit, blurred and dimmed (always drawn; the mesh covers it when it fills).
    // It only writes colour: the depth attachment keeps its cleared value (far).
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
    const c = Math.max(cw / s.w, ch / s.h), sx = cw / (s.w * c), sy = ch / (s.h * c);
    this.quad(tex.tex, [sx, -sy, 0.5 - 0.5 * sx, 0.5 + 0.5 * sy], tex.mips ? 5.5 : 0, 0.35, 1);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const maps = s.assets.maps ? this.textures.get("maps:" + s.assets.maps.hash) : undefined;
    const plate = maps && s.assets.plate ? this.textures.get("plate:" + s.assets.plate.hash) : undefined;
    gl.useProgram(this.mesh);
    gl.bindVertexArray(this.gridVao);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maps?.tex ?? this.flat); gl.uniform1i(this.mloc.u_maps, 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.tex); gl.uniform1i(this.mloc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, plate?.tex ?? this.flat); gl.uniform1i(this.mloc.u_plate, 2);
    gl.uniform1f(this.mloc.u_hasPlate, plate ? 1 : 0);
    gl.uniform1f(this.mloc.u_ia, s.w / s.h);
    gl.uniform1f(this.mloc.u_flat, maps ? 0 : 1);
    const r = cam.rot;
    gl.uniform3f(this.mloc.u_cam, cam.cam[0], cam.cam[1], cam.cam[2]);
    gl.uniformMatrix3fv(this.mloc.u_rot, false, [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]);
    gl.uniform3f(this.mloc.u_proj, cam.f, s.pivot ?? 0.5, cam.ds);
    gl.uniform3f(this.mloc.u_view, view[0], view[1], view[2]);
    gl.uniform2f(this.mloc.u_canvas, cw, ch);
    const off = Math.hypot(cam.cam[0], cam.cam[1]) + 0.3 * Math.abs(cam.cam[2]);
    gl.uniform1f(this.mloc.u_tight, smooth((off - TIGHT_FROM) / TIGHT_SPAN));
    gl.uniform2f(this.mloc.u_focus, focus[0], maps ? focus[1] : 0);
    gl.uniform1f(this.mloc.u_alpha, 1);
    gl.uniform1f(this.mloc.u_layer, 0);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    if (plate) {
      // The subject layer: only photos with a matte have one (without it the alpha planes are zero).
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.mloc.u_layer, 1);
      gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  private placeholder(rect: [number, number, number, number]): void {
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect[0], this.canvas.height - rect[1] - rect[3], rect[2], rect[3]);
    gl.clearColor(0.08, 0.08, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  private quad(tex: WebGLTexture, map: number[], lod: number, dim: number, alpha: number): void {
    const gl = this.gl;
    gl.useProgram(this.screen);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.sloc.u_tex, 0);
    gl.uniform4f(this.sloc.u_map, map[0], map[1], map[2], map[3]);
    gl.uniform3f(this.sloc.u_p, lod, dim, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    for (const k of this.keys()) this.drop(k);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Slide progress in [0, 1] at show time t. Beat accents (spec §6.3) do not jolt the frame: the
 *  move speeds up smoothly for a moment after each strong downbeat (a raised-cosine surge of
 *  ACCENT_W seconds) and runs a little slower in between, so the path, its start and its end are
 *  unchanged and the motion stays continuous. The old 2.5 % zoom pulse read as a jump (owner, 2026-11-14). */
const ACCENT_W = 0.6, ACCENT_GAIN = 0.8;
export function warpedProgress(t: number, t0: number, t1: number, accents?: number[]): number {
  const len = Math.max(t1 - t0, 1e-6);
  const lin = Math.min(len, Math.max(0, t - t0));
  if (!accents?.length) return lin / len;
  // Integral of the bump 0.5(1 − cos(2πτ/W)) over [0, τ], τ clamped to [0, W].
  const I = (tau: number) => { const u = Math.min(ACCENT_W, Math.max(0, tau)); return u / 2 - (ACCENT_W / (4 * Math.PI)) * Math.sin((2 * Math.PI * u) / ACCENT_W); };
  let num = lin, den = len;
  for (const b of accents) {
    const start = I(t0 - b); // part of the surge that fell before the slide
    num += ACCENT_GAIN * (I(t0 + lin - b) - start);
    den += ACCENT_GAIN * (I(t1 - b) - start);
  }
  return Math.min(1, Math.max(0, num / den));
}
