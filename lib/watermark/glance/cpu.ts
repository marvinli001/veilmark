import { clamp, createPlane, lumaPlane, resizePlane, type Plane, type RGBAImage } from "../core/image"
import { CHROMA_AXES, CHROMA_AXIS_GAIN, type ChromaAxis, type GlanceConfig } from "./types"

/**
 * 伪隐性水印 · CPU 参考实现（导出与批处理走这里，逐像素确定、与分辨率无关）。
 * 实时预览走 shader.ts 的 GLSL 版本，二者公式一一对应，改一处必须同步另一处。
 */

/** 可分离盒式模糊，两遍近似高斯 */
export function boxBlur(src: Plane, radius: number, passes = 2): Plane {
  if (radius < 0.5) return src
  const r = Math.round(radius)
  const { width: W, height: H } = src
  const a = new Float32Array(src.data)
  const b = new Float32Array(W * H)
  const norm = 1 / (2 * r + 1)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W
      let acc = 0
      for (let k = -r; k <= r; k++) acc += a[row + clampIndex(k, W)]
      for (let x = 0; x < W; x++) {
        b[row + x] = acc * norm
        acc += a[row + clampIndex(x + r + 1, W)] - a[row + clampIndex(x - r, W)]
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let k = -r; k <= r; k++) acc += b[clampIndex(k, H) * W + x]
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc * norm
        acc += b[clampIndex(y + r + 1, H) * W + x] - b[clampIndex(y - r, H) * W + x]
      }
    }
  }
  return { width: W, height: H, data: a }
}

function clampIndex(i: number, n: number) {
  return i < 0 ? 0 : i >= n ? n - 1 : i
}

/**
 * JND 纹理掩蔽图（1/4 分辨率）：局部标准差越大，人眼对叠加纹理越不敏感。
 * 返回值是振幅乘子，adaptive=0 时恒为 1。
 */
export function activityMap(img: RGBAImage, adaptive: number): Plane {
  const qw = Math.max(1, Math.round(img.width / 4))
  const qh = Math.max(1, Math.round(img.height / 4))
  const y = resizePlane(lumaPlane(img), qw, qh)
  const y2 = createPlane(qw, qh)
  for (let i = 0; i < y.data.length; i++) y2.data[i] = y.data[i] * y.data[i]
  const m = boxBlur(y, 2, 1)
  const m2 = boxBlur(y2, 2, 1)
  const out = createPlane(qw, qh)
  const lo = 1 - 0.6 * adaptive
  const hi = 1 + 0.5 * adaptive
  for (let i = 0; i < out.data.length; i++) {
    const std = Math.sqrt(Math.max(0, m2.data[i] - m.data[i] * m.data[i]))
    out.data[i] = adaptive <= 0 ? 1 : clamp(lo + (std / 14) * adaptive, lo, hi)
  }
  return out
}

function sampleBilinear(p: Plane, fx: number, fy: number) {
  const x = clamp(fx, 0, p.width - 1)
  const y = clamp(fy, 0, p.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, p.width - 1)
  const y1 = Math.min(y0 + 1, p.height - 1)
  const tx = x - x0
  const ty = y - y0
  const d = p.data
  const a = d[y0 * p.width + x0] + (d[y0 * p.width + x1] - d[y0 * p.width + x0]) * tx
  const b = d[y1 * p.width + x0] + (d[y1 * p.width + x1] - d[y1 * p.width + x0]) * tx
  return a + (b - a) * ty
}

/** 画面主色偏蓝/黄时改用红–绿轴，反之用蓝–黄轴（蓝–黄对人眼更隐蔽，优先） */
export function resolveChromaAxis(img: RGBAImage, axis: ChromaAxis): Exclude<ChromaAxis, "auto"> {
  if (axis !== "auto") return axis
  let cb = 0
  let cr = 0
  const d = img.data
  for (let i = 0; i < d.length; i += 16) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    cb += Math.abs(d[i + 2] - y)
    cr += Math.abs(d[i] - y)
  }
  return cb > cr * 2 ? "red-green" : "blue-yellow"
}

/** 整数哈希抖动（TPDF 近似），保证亚灰阶振幅在取整后仍保留均值 */
function dither(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) & 0xffff) / 65536 - 0.5
}

/** 羽化半径（像素）= 短边 × feather‰ */
export function featherRadius(cfg: GlanceConfig, width: number, height: number) {
  return (cfg.feather / 1000) * Math.min(width, height)
}

/**
 * 预计算：羽化掩膜、JND 图、色度轴。CPU 导出与 WebGL 预览共用（预览在 Worker 里分项缓存，
 * 调用的也是 boxBlur / activityMap / resolveChromaAxis 这三个函数）。
 * @param mask 信息掩膜（0–1，已与图像同尺寸），通常来自 renderTextMask
 */
export function prepareGlanceMaps(img: RGBAImage, mask: Plane, cfg: GlanceConfig) {
  return {
    soft: boxBlur(mask, featherRadius(cfg, img.width, img.height)),
    act: activityMap(img, cfg.adaptive),
    axis: resolveChromaAxis(img, cfg.chroma.axis),
  }
}

export function applyGlance(
  img: RGBAImage,
  mask: Plane,
  cfg: GlanceConfig,
  maps: ReturnType<typeof prepareGlanceMaps> = prepareGlanceMaps(img, mask, cfg)
): RGBAImage {
  const { width: W, height: H } = img
  const { soft, act, axis: axisName } = maps
  const sx = act.width / W
  const sy = act.height / H

  const g = cfg.grating
  const pa = cfg.pantograph
  const t = cfg.tone
  const c = cfg.chroma
  const axis = CHROMA_AXES[axisName]
  const chromaAmp = c.amplitude * CHROMA_AXIS_GAIN[axisName]
  const theta = (g.angle * Math.PI) / 180
  const kx = (Math.cos(theta) * 2 * Math.PI) / g.period
  const ky = (Math.sin(theta) * 2 * Math.PI) / g.period
  const kc = (2 * Math.PI) / pa.coarsePeriod

  const out = new Uint8ClampedArray(img.data)
  const src = img.data
  for (let y = 0; y < H; y++) {
    const cy = Math.cos(kc * (y + 0.5))
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      const i = p * 4
      const R = src[i]
      const G = src[i + 1]
      const B = src[i + 2]
      const Y = 0.299 * R + 0.587 * G + 0.114 * B
      const m = soft.data[p]
      const A = sampleBilinear(act, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)
      // 高光/暗部余量：避免截断破坏“零均值”，截断本身就会让水印在平均后显形
      const head = clamp(Math.min(Y, 255 - Y) / 20, 0.1, 1)
      const checker = (x + y) & 1 ? 1 : -1
      const sign = 2 * m - 1 // 信息区 +1，背景 −1

      let dy = 0
      if (g.enabled) {
        const carrier = g.kind === "checker" ? checker : Math.cos(kx * x + ky * y)
        dy += g.amplitude * A * head * carrier * -sign // 相位反转：背景 +carrier，信息区 −carrier
      }
      if (pa.enabled) {
        const coarse = 1.6 * Math.cos(kc * (x + 0.5)) * cy
        dy += pa.amplitude * A * head * ((1 - m) * checker + m * coarse)
      }
      if (t.enabled) {
        const w = 1 + t.shadowBias * (1.5 * (1 - Y / 255) ** 2 - 0.5)
        dy += t.amplitude * A * head * sign * w
      }
      let dr = dy
      let dg = dy
      let db = dy
      if (c.enabled) {
        const k = chromaAmp * A * sign
        dr += k * axis[0]
        dg += k * axis[1]
        db += k * axis[2]
      }
      const n = dither(x, y)
      out[i] = R + dr + n
      out[i + 1] = G + dg + n
      out[i + 2] = B + db + n
    }
  }
  return { width: W, height: H, data: out }
}
