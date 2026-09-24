import sharp, { type Sharp } from "sharp"

import { clamp255, type RGBAImage } from "../../lib/watermark/core/image"
import { mulberry32 } from "../../lib/watermark/core/prng"

export async function loadRGBA(path: string, maxSide?: number): Promise<RGBAImage> {
  let pipe = sharp(path).rotate().ensureAlpha()
  if (maxSide) pipe = pipe.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
}

export function toSharp(img: RGBAImage) {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
}

async function fromSharp(pipe: Sharp): Promise<RGBAImage> {
  const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
}

async function roundtrip(img: RGBAImage, encode: (s: Sharp) => Sharp) {
  const buf = await encode(toSharp(img)).toBuffer()
  return fromSharp(sharp(buf))
}

function mapPixels(img: RGBAImage, f: (v: number, c: number) => number): RGBAImage {
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < out.length; i++) out[i] = (i & 3) === 3 ? img.data[i] : clamp255(f(img.data[i], i & 3))
  return { width: img.width, height: img.height, data: out }
}

export type Attack = { name: string; run: (img: RGBAImage) => Promise<RGBAImage> }

/** 覆盖“传播链路”上常见的破坏：压缩、缩放、截图、调色、噪声、模糊 */
export const ATTACKS: Attack[] = [
  { name: "无攻击 PNG", run: async (i) => i },
  { name: "JPEG q90", run: (i) => roundtrip(i, (s) => s.jpeg({ quality: 90 })) },
  { name: "JPEG q75", run: (i) => roundtrip(i, (s) => s.jpeg({ quality: 75 })) },
  { name: "JPEG q50", run: (i) => roundtrip(i, (s) => s.jpeg({ quality: 50 })) },
  { name: "WebP q75", run: (i) => roundtrip(i, (s) => s.webp({ quality: 75 })) },
  { name: "缩放 50%", run: (i) => roundtrip(i, (s) => s.resize(Math.round(i.width / 2)).png()) },
  { name: "缩放 25%", run: (i) => roundtrip(i, (s) => s.resize(Math.round(i.width / 4)).png()) },
  { name: "放大 150%", run: (i) => roundtrip(i, (s) => s.resize(Math.round(i.width * 1.5)).png()) },
  {
    name: "截图(60%+边框)",
    run: (i) =>
      roundtrip(i, (s) =>
        s
          .resize(Math.round(i.width * 0.6))
          .extend({ top: 40, bottom: 16, left: 16, right: 16, background: "#f4f4f5" })
          .png()
      ),
  },
  { name: "缩放50%+JPEG75", run: (i) => roundtrip(i, (s) => s.resize(Math.round(i.width / 2)).jpeg({ quality: 75 })) },
  { name: "亮度 +10", run: async (i) => mapPixels(i, (v) => v + 10) },
  { name: "亮度 −10", run: async (i) => mapPixels(i, (v) => v - 10) },
  { name: "对比度 ×1.25", run: async (i) => mapPixels(i, (v) => (v - 128) * 1.25 + 128) },
  { name: "Gamma 0.8", run: async (i) => mapPixels(i, (v) => 255 * Math.pow(v / 255, 0.8)) },
  { name: "饱和度 ×1.5", run: (i) => roundtrip(i, (s) => s.modulate({ saturation: 1.5 }).png()) },
  {
    name: "高斯噪声 σ=5",
    run: async (i) => {
      const rnd = mulberry32(7)
      return mapPixels(i, (v) => {
        const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
        return v + 5 * g
      })
    },
  },
  { name: "高斯模糊 σ=1.5", run: (i) => roundtrip(i, (s) => s.blur(1.5).png()) },
  {
    name: "裁剪 5%（已知局限）",
    run: (i) =>
      roundtrip(i, (s) =>
        s
          .extract({
            left: Math.round(i.width * 0.025),
            top: Math.round(i.height * 0.025),
            width: Math.round(i.width * 0.95),
            height: Math.round(i.height * 0.95),
          })
          .png()
      ),
  },
]

/** 确定性的“类自然图像”：大片平坦天空 + fBm 纹理 + 硬边缘，覆盖盲水印最难的平坦区 */
export function syntheticPhoto(width = 1600, height = 1067, seed = 1): RGBAImage {
  const rnd = mulberry32(seed)
  const G = 64
  const grid = Array.from({ length: (G + 1) * (G + 1) }, () => rnd())
  const noise = (x: number, y: number) => {
    const gx = x * G
    const gy = y * G
    const x0 = Math.floor(gx) % G
    const y0 = Math.floor(gy) % G
    const fx = gx - Math.floor(gx)
    const fy = gy - Math.floor(gy)
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const at = (i: number, j: number) => grid[((j % (G + 1)) * (G + 1)) + (i % (G + 1))]
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
    return a + (b - a) * sy
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / width
      const v = y / height
      let f = 0
      let amp = 0.5
      let freq = 0.05
      for (let o = 0; o < 6; o++) {
        f += amp * noise((u * freq * 20) % 1, (v * freq * 20) % 1)
        amp *= 0.5
        freq *= 2.03
      }
      const horizon = 0.42 + 0.05 * Math.sin(u * 9)
      const i = (y * width + x) * 4
      if (v < horizon) {
        // 天空：平滑渐变，几乎无纹理
        data[i] = 120 + 60 * v
        data[i + 1] = 165 + 40 * v
        data[i + 2] = 225 - 10 * v
      } else {
        const t = f * 255
        data[i] = 0.55 * t + 40
        data[i + 1] = 0.7 * t + 30
        data[i + 2] = 0.35 * t + 20
      }
      data[i + 3] = 255
    }
  return { width, height, data }
}

/** Node 下的文字掩膜替身（浏览器里用 renderTextMask），用 SVG 平铺斜向文字；bold 与 GlanceConfig.bold 同义 */
export async function svgTextMask(W: number, H: number, text = "© VEILMARK", sizePct = 9, bold = 0) {
  const fs = Math.round(Math.min(W, H) * (sizePct / 100))
  let texts = ""
  for (let r = -8; r < 16; r++)
    for (let c = -6; c < 12; c++) {
      const x = c * fs * 5.2 + (r % 2 ? fs * 2.6 : 0)
      const y = r * fs * 1.9
      texts += `<text x="${x}" y="${y}" font-size="${fs}" font-family="Helvetica" font-weight="800" fill="#fff">${text}</text>`
    }
  const stroke = bold > 0 ? ` stroke="#fff" stroke-width="${bold * fs * 2}" stroke-linejoin="round"` : ""
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#000"/><g transform="rotate(-30 ${W / 2} ${H / 2})"${stroke}>${texts}</g></svg>`
  const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { width: W, height: H, data: Float32Array.from(data, (v) => v / 255) }
}
