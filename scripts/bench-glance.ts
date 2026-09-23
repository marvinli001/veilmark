/**
 * 伪隐性水印“隐蔽性 vs 显形度”量化基准
 *
 *   npx tsx scripts/bench-glance.ts [图片路径...]
 *
 * 指标：把（处理后 − 原图）在 900px 适屏尺度下，按掩膜分成“信息区/背景区”，
 * 取两区均值差（亮度 ΔY 与色度 ΔC，单位 8-bit 灰阶）。日常观看的亮度 JND 约 1–2 级。
 *   - “适屏可见度”越接近 0 越好（日常浏览看不见）
 *   - 各攻击下的“显形度”越大越好（盗用后浮现）
 */
import { applyGlance } from "../lib/watermark/glance/cpu"
import { REVEAL_LABELS, simulateReveal, type RevealKind } from "../lib/watermark/glance/simulate"
import { glancePreset } from "../lib/watermark/glance/types"
import { psnr, resizePlane, resizeRGBA, type Plane, type RGBAImage } from "../lib/watermark/core/image"
import { loadRGBA, svgTextMask, syntheticPhoto } from "../tests/helpers/image-io"

const FIT = 900

function regionContrast(a: RGBAImage, b: RGBAImage, mask: Plane) {
  const h = Math.round((a.height / a.width) * FIT)
  const A = resizeRGBA(a, FIT, h)
  const B = resizeRGBA(b, FIT, h)
  const M = resizePlane(mask, FIT, h)
  let ym = 0, yb = 0, cm = 0, cb = 0, nm = 0, nb = 0
  for (let p = 0; p < M.data.length; p++) {
    const i = p * 4
    const dr = B.data[i] - A.data[i], dg = B.data[i + 1] - A.data[i + 1], db = B.data[i + 2] - A.data[i + 2]
    const dy = 0.299 * dr + 0.587 * dg + 0.114 * db
    const dc = Math.hypot(dr - dy, db - dy) // 近似色度差
    const signedC = (db - dy) - (dr - dy)
    if (M.data[p] > 0.6) { ym += dy; cm += signedC; nm++ } else if (M.data[p] < 0.05) { yb += dy; cb += signedC; nb++ }
    void dc
  }
  return { dY: Math.abs(ym / nm - yb / nb), dC: Math.abs(cm / nm - cb / nb) }
}

const KINDS: RevealKind[] = ["contrast", "shadow-lift", "desaturate-avg", "saturation", "sharpen", "nearest-50", "nearest-37", "print"]

async function run(label: string, img: RGBAImage) {
  const mask = await svgTextMask(img.width, img.height)
  console.log(`\n## ${label} ${img.width}×${img.height}`)
  console.log(`| 模式 | PSNR | 适屏可见度 ΔY/ΔC | ${KINDS.map((k) => REVEAL_LABELS[k]).join(" | ")} |`)
  console.log(`| --- | --- | --- | ${KINDS.map(() => "---").join(" | ")} |`)
  for (const mode of ["daily", "print", "screenshot"] as const) {
    const wm = applyGlance(img, mask, glancePreset(mode))
    const base = regionContrast(img, wm, mask)
    const cells = KINDS.map((k) => {
      const so = simulateReveal(img, k)
      const sw = simulateReveal(wm, k)
      const m = so.width === img.width ? mask : resizePlane(mask, so.width, so.height)
      const r = regionContrast(so, sw, m)
      return `${r.dY.toFixed(1)}/${r.dC.toFixed(1)}`
    })
    console.log(`| ${mode} | ${psnr(img, wm).toFixed(1)} | ${base.dY.toFixed(1)}/${base.dC.toFixed(1)} | ${cells.join(" | ")} |`)
  }
}

const paths = process.argv.slice(2)
if (!paths.length) await run("合成图", syntheticPhoto())
for (const p of paths) await run(p.split("/").pop()!, await loadRGBA(p, 2400))
