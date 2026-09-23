import type { Plane } from "../core/image"
import { CHROMA_AXES, CHROMA_AXIS_GAIN, type GlanceConfig } from "./types"

/**
 * 伪隐性水印 · WebGL2 实时预览。
 * 与 cpu.ts 的 applyGlance 逐项对应（掩膜羽化与 JND 图在 CPU 上预计算后作为纹理上传），
 * 拖动滑杆时只改 uniform，4K 图也能保持 60fps。导出仍走 CPU 版本，保证逐像素确定。
 */

export const GLANCE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;   // sRGB 原图（未预乘）
uniform sampler2D u_mask;    // R: 羽化后的信息掩膜 0–1
uniform sampler2D u_act;     // R: JND 振幅乘子（已除以 2 存入 0–1）
uniform vec2 u_size;

uniform vec4 u_grating;      // enabled, amplitude, kind(0 checker/1 lines), period
uniform float u_gratingAngle;
uniform vec3 u_panto;        // enabled, amplitude, coarsePeriod
uniform vec3 u_tone;         // enabled, amplitude, shadowBias
uniform vec4 u_chroma;       // enabled, amplitude(已乘轴增益), 保留, 保留
uniform vec3 u_chromaAxis;

in vec2 v_uv;
out vec4 outColor;

float hash(vec2 p) {
  // 与 CPU 版不同的哈希：抖动只是为了保均值，两端不要求逐像素一致
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void main() {
  vec2 px = floor(v_uv * u_size);            // 整数像素坐标，保证光栅与像素网格对齐
  vec4 src = texture(u_image, v_uv);
  vec3 rgb = src.rgb * 255.0;
  float Y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float m = texture(u_mask, v_uv).r;
  float A = texture(u_act, v_uv).r * 2.0;
  float head = clamp(min(Y, 255.0 - Y) / 20.0, 0.1, 1.0);
  float checker = mod(px.x + px.y, 2.0) > 0.5 ? 1.0 : -1.0;
  float sgn = 2.0 * m - 1.0;

  float dy = 0.0;
  if (u_grating.x > 0.5) {
    float th = radians(u_gratingAngle);
    float lines = cos(6.2831853 * (px.x * cos(th) + px.y * sin(th)) / u_grating.w);
    float carrier = u_grating.z < 0.5 ? checker : lines;
    dy += u_grating.y * A * head * carrier * -sgn;
  }
  if (u_panto.x > 0.5) {
    float kc = 6.2831853 / u_panto.z;
    float coarse = 1.6 * cos(kc * (px.x + 0.5)) * cos(kc * (px.y + 0.5));
    dy += u_panto.y * A * head * ((1.0 - m) * checker + m * coarse);
  }
  if (u_tone.x > 0.5) {
    float w = 1.0 + u_tone.z * (1.5 * pow(1.0 - Y / 255.0, 2.0) - 0.5);
    dy += u_tone.y * A * head * sgn * w;
  }
  vec3 d = vec3(dy);
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

function planeToR8(plane: Plane, scale = 1): Uint8Array {
  const out = new Uint8Array(plane.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(plane.data[i] * scale * 255)))
  return out
}

export interface GlanceRenderer {
  /** 上传新图（切换图片时调用一次） */
  setImage(source: TexImageSource, width: number, height: number): void
  /** 上传掩膜与 JND 图（文字/排版/羽化变化时调用） */
  setMaps(mask: Plane, activity: Plane): void
  /** 只改 uniform，开销极低 */
  render(cfg: GlanceConfig, axis: "blue-yellow" | "red-green"): void
  dispose(): void
}

export function createGlanceRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): GlanceRenderer {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
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
  const texAct = makeTex(2, gl.LINEAR)
  const u = (n: string) => gl.getUniformLocation(prog, n)
  gl.uniform1i(u("u_image"), 0)
  gl.uniform1i(u("u_mask"), 1)
  gl.uniform1i(u("u_act"), 2)

  let size = { w: 1, h: 1 }

  return {
    setImage(source, width, height) {
      size = { w: width, h: height }
      canvas.width = width
      canvas.height = height
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texImage)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    },
    setMaps(mask, activity) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, texMask)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, planeToR8(mask))
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, texAct)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, activity.width, activity.height, 0, gl.RED, gl.UNSIGNED_BYTE, planeToR8(activity, 0.5))
    },
    render(cfg, axis) {
      const g = cfg.grating
      gl.viewport(0, 0, size.w, size.h)
      gl.uniform2f(u("u_size"), size.w, size.h)
      gl.uniform4f(u("u_grating"), g.enabled ? 1 : 0, g.amplitude, g.kind === "checker" ? 0 : 1, g.period)
      gl.uniform1f(u("u_gratingAngle"), g.angle)
      gl.uniform3f(u("u_panto"), cfg.pantograph.enabled ? 1 : 0, cfg.pantograph.amplitude, cfg.pantograph.coarsePeriod)
      gl.uniform3f(u("u_tone"), cfg.tone.enabled ? 1 : 0, cfg.tone.amplitude, cfg.tone.shadowBias)
      gl.uniform4f(u("u_chroma"), cfg.chroma.enabled ? 1 : 0, cfg.chroma.amplitude * CHROMA_AXIS_GAIN[axis], 0, 0)
      const [ax, ay, az] = CHROMA_AXES[axis]
      gl.uniform3f(u("u_chromaAxis"), ax, ay, az)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }
}
