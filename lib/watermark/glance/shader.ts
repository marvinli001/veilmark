import type { Plane } from "../core/image"
import { CHROMA_AXES, CHROMA_AXIS_GAIN, GRATING_CHROMA_AXIS, type GlanceConfig } from "./types"

/**
 * 伪隐性水印 · WebGL2 实时预览。
 * 与 cpu.ts 的 applyGlance 逐项对应（掩膜羽化与 JND 图在 CPU 上预计算后作为 R8 纹理上传），
 * 拖动滑杆时只改 uniform，4K 图也能保持 60fps。导出仍走 CPU 版本，保证逐像素确定。
 *
 * 与 CPU 版的已知差异（均在验收阈值内）：
 * - 抖动哈希不同，单像素允许 ±1；
 * - 掩膜与 JND 图量化为 8 bit（CPU 用浮点），误差 < 0.2 级；
 * - 三角函数先用 fract 做区间规约再求值：数学上与 CPU 相同，但避免 GPU 在大参数（上千弧度）下的精度损失。
 */

export const GLANCE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;   // sRGB 原图（未预乘）
uniform sampler2D u_mask;    // R: 羽化后的信息掩膜 0–1
uniform sampler2D u_act;     // R: JND 振幅乘子（已除以 2 存入 0–1）
uniform vec2 u_size;

uniform vec4 u_grating;      // enabled, amplitude, kind(0 checker/1 lines), period
uniform float u_gratingAngle;
uniform float u_gratingChroma; // 光栅色度路振幅（0 = 关）
uniform vec3 u_panto;        // enabled, amplitude, coarsePeriod
uniform vec3 u_tone;         // enabled, amplitude, shadowBias
uniform vec4 u_chroma;       // enabled, amplitude(已乘轴增益), 保留, 保留
uniform vec3 u_chromaAxis;

in vec2 v_uv;
out vec4 outColor;

const float TAU = 6.2831853;
const vec3 GRATING_AXIS = vec3(${GRATING_CHROMA_AXIS.join(", ")});

float hash(vec2 p) {
  // 与 CPU 版不同的哈希：抖动只是为了保均值，两端不要求逐像素一致
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void main() {
  vec2 px = floor(v_uv * u_size);            // 整数像素坐标，保证光栅与像素网格对齐（y 向下，与 CPU 行号一致）
  vec4 src = texture(u_image, v_uv);
  vec3 rgb = src.rgb * 255.0;
  float Y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float m = texture(u_mask, v_uv).r;
  float A = texture(u_act, v_uv).r * 2.0;
  float head = clamp(min(Y, 255.0 - Y) / 20.0, 0.1, 1.0);
  float checker = mod(px.x + px.y, 2.0) > 0.5 ? 1.0 : -1.0;
  float sgn = 2.0 * m - 1.0;

  float dy = 0.0;
  vec3 d = vec3(0.0);
  if (u_grating.x > 0.5) {
    float th = radians(u_gratingAngle);
    // CPU: cos(kx·x + ky·y)，kx = cos θ·2π/period
    float lines = cos(TAU * fract((px.x * cos(th) + px.y * sin(th)) / u_grating.w));
    float carrier = u_grating.z < 0.5 ? checker : lines;
    dy += u_grating.y * A * head * carrier * -sgn;
    if (u_gratingChroma > 0.0) {
      // CPU: room = min(B 余量, min(R, G 余量) / axis.r)，取一半
      vec3 room3 = min(rgb, 255.0 - rgb);
      float room = min(room3.b, min(room3.r, room3.g) / GRATING_AXIS.r);
      d += min(u_gratingChroma, room * 0.5) * carrier * -sgn * GRATING_AXIS;
    }
  }
  if (u_panto.x > 0.5) {
    // CPU: 1.6·cos(kc·(x+0.5))·cos(kc·(y+0.5))，kc = 2π/coarsePeriod
    float coarse = 1.6 * cos(TAU * fract((px.x + 0.5) / u_panto.z)) * cos(TAU * fract((px.y + 0.5) / u_panto.z));
    dy += u_panto.y * A * head * ((1.0 - m) * checker + m * coarse);
  }
  if (u_tone.x > 0.5) {
    float s = 1.0 - Y / 255.0;                // CPU: (1 − Y/255)²；不用 pow，避免 pow(0, 2) 在部分驱动上未定义
    float w = 1.0 + u_tone.z * (1.5 * s * s - 0.5);
    dy += u_tone.y * A * head * sgn * w;
  }
  d += dy;
  if (u_chroma.x > 0.5) d += u_chroma.y * A * sgn * u_chromaAxis;

  vec3 outRgb = floor(rgb + d + hash(px) + 0.5);
  outColor = vec4(clamp(outRgb, 0.0, 255.0) / 255.0, src.a);
}`

const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader 编译失败")
  return s
}

/** 单通道 8 bit 平面（R8 纹理的数据），Worker 与主线程之间以 transferable 传递 */
export interface R8Plane {
  width: number
  height: number
  data: Uint8Array
}

export function planeToR8(plane: Plane, scale = 1): R8Plane {
  const out = new Uint8Array(plane.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(plane.data[i] * scale * 255)))
  return { width: plane.width, height: plane.height, data: out }
}

/** JND 振幅乘子范围约 0.4–1.5，存入 R8 前除以 2 */
export const ACT_R8_SCALE = 0.5

export interface WebGLCaps {
  webgl2: boolean
  maxTextureSize: number
}

/** 探测 WebGL2 与纹理尺寸上限（决定能否走实时预览） */
export function probeWebGL2(): WebGLCaps {
  try {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null
    if (!gl) return { webgl2: false, maxTextureSize: 0 }
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    gl.getExtension("WEBGL_lose_context")?.loseContext()
    return { webgl2: true, maxTextureSize }
  } catch {
    return { webgl2: false, maxTextureSize: 0 }
  }
}

export interface GlanceRenderer {
  readonly width: number
  readonly height: number
  /** 上传新图（切换图片或底图变化时调用） */
  setImage(source: TexImageSource, width: number, height: number): void
  /** 上传掩膜与 JND 图（浮点平面，内部量化为 R8） */
  setMaps(mask: Plane, activity: Plane): void
  /** 上传已量化的 R8 掩膜与 JND 图（Worker 预计算后直接传来，act 已乘 ACT_R8_SCALE） */
  setMapsR8(mask: R8Plane, activity: R8Plane): void
  /** 只改 uniform，开销极低 */
  render(cfg: GlanceConfig, axis: "blue-yellow" | "red-green"): void
  /** 读回整帧（自上而下的 RGBA），用于与 CPU 版比对 */
  readPixels(): Uint8Array
  /** 读回 1 个像素，强制等待 GPU 完成（用于测单帧耗时） */
  sync(): void
  dispose(): void
}

export function createGlanceRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): GlanceRenderer {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  }) as WebGL2RenderingContext | null
  if (!gl) throw new Error("当前浏览器不支持 WebGL2，将回退到 CPU 预览")
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, GLANCE_FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link 失败")
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, "a_pos")
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const makeTex = (unit: number, filter: number) => {
    const t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  // 原图必须 NEAREST：光栅是逐像素的，任何插值都会破坏它
  const texImage = makeTex(0, gl.NEAREST)
  const texMask = makeTex(1, gl.NEAREST)
  // JND 图是 1/4 分辨率，LINEAR 采样恰好等价于 CPU 的 sampleBilinear（像素中心对齐 + 边缘钳制）
  const texAct = makeTex(2, gl.LINEAR)
  const names = [
    "u_image",
    "u_mask",
    "u_act",
    "u_size",
    "u_grating",
    "u_gratingAngle",
    "u_gratingChroma",
    "u_panto",
    "u_tone",
    "u_chroma",
    "u_chromaAxis",
  ] as const
  const u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<
    (typeof names)[number],
    WebGLUniformLocation | null
  >
  gl.uniform1i(u.u_image, 0)
  gl.uniform1i(u.u_mask, 1)
  gl.uniform1i(u.u_act, 2)

  let size = { w: 1, h: 1 }

  const uploadR8 = (unit: number, tex: WebGLTexture, p: R8Plane) => {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, p.width, p.height, 0, gl.RED, gl.UNSIGNED_BYTE, p.data)
  }

  return {
    get width() {
      return size.w
    },
    get height() {
      return size.h
    },
    setImage(source, width, height) {
      size = { w: width, h: height }
      canvas.width = width
      canvas.height = height
      // 浏览器可能因内存限制缩小绘图缓冲区，此时逐像素预览失去意义，交给调用方回退
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height)
        throw new Error(`绘图缓冲区被限制为 ${gl.drawingBufferWidth}×${gl.drawingBufferHeight}`)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texImage)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    },
    setMaps(mask, activity) {
      uploadR8(1, texMask, planeToR8(mask))
      uploadR8(2, texAct, planeToR8(activity, ACT_R8_SCALE))
    },
    setMapsR8(mask, activity) {
      uploadR8(1, texMask, mask)
      uploadR8(2, texAct, activity)
    },
    render(cfg, axis) {
      const g = cfg.grating
      gl.viewport(0, 0, size.w, size.h)
      gl.uniform2f(u.u_size, size.w, size.h)
      gl.uniform4f(u.u_grating, g.enabled ? 1 : 0, g.amplitude, g.kind === "checker" ? 0 : 1, g.period)
      gl.uniform1f(u.u_gratingAngle, g.angle)
      gl.uniform1f(u.u_gratingChroma, g.enabled ? g.chroma : 0)
      gl.uniform3f(u.u_panto, cfg.pantograph.enabled ? 1 : 0, cfg.pantograph.amplitude, cfg.pantograph.coarsePeriod)
      gl.uniform3f(u.u_tone, cfg.tone.enabled ? 1 : 0, cfg.tone.amplitude, cfg.tone.shadowBias)
      gl.uniform4f(u.u_chroma, cfg.chroma.enabled ? 1 : 0, cfg.chroma.amplitude * CHROMA_AXIS_GAIN[axis], 0, 0)
      const [ax, ay, az] = CHROMA_AXES[axis]
      gl.uniform3f(u.u_chromaAxis, ax, ay, az)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    readPixels() {
      const { w, h } = size
      const raw = new Uint8Array(w * h * 4)
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
      // 帧缓冲的行序是自下而上，翻成与 ImageData 一致的自上而下
      const out = new Uint8Array(raw.length)
      const row = w * 4
      for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row)
      return out
    },
    sync() {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }
}
