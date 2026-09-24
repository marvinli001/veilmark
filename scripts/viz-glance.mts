import sharp from "sharp"
import { applyGlance } from "../lib/watermark/glance/cpu"
import { glancePreset } from "../lib/watermark/glance/types"
import { simulateReveal, type RevealKind } from "../lib/watermark/glance/simulate"
import { psnr, type RGBAImage } from "../lib/watermark/core/image"
import { loadRGBA, toSharp } from "../tests/helpers/image-io"

const [src, out, mode] = process.argv.slice(2) as [string, string, "daily" | "print" | "screenshot" | "hybrid"]
const img = await loadRGBA(src, 2400)
const W = img.width, H = img.height, short = Math.min(W, H)
const fs = Math.round(short * 0.09)
// SVG 平铺文字掩膜（与 renderTextMask 等价的 Node 替身）
let texts = ""
for (let r = -8; r < 16; r++) for (let c = -6; c < 12; c++) {
  const x = c * fs * 5.2 + (r % 2 ? fs * 2.6 : 0), y = r * fs * 1.9
  texts += `<text x="${x}" y="${y}" font-size="${fs}" font-family="Helvetica" font-weight="800" fill="#fff">© VEILMARK</text>`
}
const cfg = glancePreset(mode)
const stroke = cfg.bold > 0 ? ` stroke="#fff" stroke-width="${cfg.bold * fs * 2}" stroke-linejoin="round"` : ""
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#000"/><g transform="rotate(-30 ${W / 2} ${H / 2})"${stroke}>${texts}</g></svg>`
const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true })
const mask = { width: W, height: H, data: Float32Array.from(data, (v) => v / 255) }
const wm = applyGlance(img, mask, cfg)
console.log(mode, "PSNR", psnr(img, wm).toFixed(2))
const save = (i: RGBAImage, name: string, width?: number) => { let s = toSharp(i); if (width) s = s.resize(width); return s.png().toFile(`${out}_${name}.png`) }
await save(wm, "fit_900", 900)
const crop = { left: Math.round(W * 0.3), top: Math.round(H * 0.15), width: 700, height: 450 }
await toSharp(wm).extract(crop).png().toFile(`${out}_crop.png`)
await toSharp(img).extract(crop).png().toFile(`${out}_crop_orig.png`)
const kinds: RevealKind[] = ["contrast", "shadow-lift", "desaturate-avg", "saturation", "nearest-50", "nearest-37", "sharpen", "print"]
for (const k of kinds) {
  const a = simulateReveal(wm, k)
  const b = simulateReveal(img, k)
  // 并排：左=原图经同样处理，右=水印图经同样处理
  const w2 = 600, h2 = Math.round((a.height / a.width) * w2)
  const L = await toSharp(b).resize(w2, h2, { kernel: "cubic" }).png().toBuffer()
  const R = await toSharp(a).resize(w2, h2, { kernel: "cubic" }).png().toBuffer()
  await sharp({ create: { width: w2 * 2 + 10, height: h2, channels: 3, background: "#fff" } }).composite([{ input: L, left: 0, top: 0 }, { input: R, left: w2 + 10, top: 0 }]).png().toFile(`${out}_reveal_${k}.png`)
}
