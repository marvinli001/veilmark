import { clamp255, createPlane, lumaPlane, type RGBAImage } from "../core/image"
import { boxBlur } from "./cpu"

/**
 * “盗用模拟器”：在浏览器里复现常见的二次加工，让用户导出前就能看到水印何时显形。
 * 这些是近似模型（尤其是打印），目的在于调参，而非精确预测某台打印机。
 */

export type RevealKind =
  | "contrast"
  | "shadow-lift"
  | "desaturate-avg"
  | "saturation"
  | "nearest-50"
  | "nearest-37"
  | "sharpen"
  | "print"

export const REVEAL_LABELS: Record<RevealKind, string> = {
  contrast: "对比度 +120%",
  "shadow-lift": "提亮阴影",
  "desaturate-avg": "平均法去色",
  saturation: "饱和度 ×3",
  "nearest-50": "最近邻缩放 50%",
  "nearest-37": "非整数缩放 37%",
  sharpen: "USM 锐化",
  print: "打印模拟（网点扩大）",
}

function map(img: RGBAImage, f: (r: number, g: number, b: number) => [number, number, number]): RGBAImage {
  const out = new Uint8ClampedArray(img.data.length)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = f(d[i], d[i + 1], d[i + 2])
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
    out[i + 3] = d[i + 3]
  }
  return { width: img.width, height: img.height, data: out }
}

function nearest(img: RGBAImage, scale: number): RGBAImage {
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale))
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

export function simulateReveal(img: RGBAImage, kind: RevealKind): RGBAImage {
  switch (kind) {
    case "contrast": {
      let mean = 0
      for (let i = 0; i < img.data.length; i += 4) mean += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114
      mean /= img.data.length / 4
      return map(img, (r, g, b) => [(r - mean) * 2.2 + mean, (g - mean) * 2.2 + mean, (b - mean) * 2.2 + mean])
    }
    case "shadow-lift": {
      const lut = Array.from({ length: 256 }, (_, v) => 255 * (v / 255) ** 0.45)
      return map(img, (r, g, b) => [lut[r], lut[g], lut[b]])
    }
    case "desaturate-avg":
      return map(img, (r, g, b) => {
        const v = (r + g + b) / 3
        return [v, v, v]
      })
    case "saturation":
      return map(img, (r, g, b) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        return [y + (r - y) * 3, y + (g - y) * 3, y + (b - y) * 3]
      })
    case "nearest-50":
      return nearest(img, 0.5)
    case "nearest-37":
      return nearest(img, 0.37)
    case "sharpen": {
      const y = lumaPlane(img)
      const blur = boxBlur(y, 1, 2)
      let p = 0
      return map(img, (r, g, b) => {
        const d = 1.8 * (y.data[p] - blur.data[p])
        p++
        return [r + d, g + d, b + d]
      })
    }
    case "print": {
      // 网点扩大模型：局部高频能量越高（网点越细、周长越大）→ 油墨扩散越多 → 越暗；
      // 再用模糊模拟打印机无法解析 2px 级细节。
      const y = lumaPlane(img)
      const hf = createPlane(img.width, img.height)
      const lp = boxBlur(y, 1, 1)
      for (let i = 0; i < hf.data.length; i++) hf.data[i] = Math.abs(y.data[i] - lp.data[i])
      const gain = boxBlur(hf, 3, 2)
      const darken = new Float32Array(hf.data.length)
      for (let i = 0; i < darken.length; i++) darken[i] = 2.2 * gain.data[i]
      const inked = map(img, (r, g, b) => [r, g, b])
      for (let i = 0, p = 0; p < darken.length; i += 4, p++)
        for (let ch = 0; ch < 3; ch++) inked.data[i + ch] = clamp255(inked.data[i + ch] - darken[p])
      // 墨点扩散
      const planes = [0, 1, 2].map((ch) => {
        const pl = createPlane(img.width, img.height)
        for (let p = 0; p < pl.data.length; p++) pl.data[p] = inked.data[p * 4 + ch]
        return boxBlur(pl, 1.5, 2)
      })
      for (let p = 0; p < planes[0].data.length; p++)
        for (let ch = 0; ch < 3; ch++) inked.data[p * 4 + ch] = planes[ch].data[p]
      return inked
    }
  }
}

/** 差异放大视图：|a−b|×gain，用来直观看到水印能量分布 */
export function amplifiedDiff(a: RGBAImage, b: RGBAImage, gain = 12): RGBAImage {
  const out = new Uint8ClampedArray(a.data.length)
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = 128 + (b.data[i + c] - a.data[i + c]) * gain
    out[i + 3] = 255
  }
  return { width: a.width, height: a.height, data: out }
}
