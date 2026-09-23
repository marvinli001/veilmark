/**
 * 盲水印鲁棒性基准：CDP（本项目方案） vs SVD-QIM（blind_watermark 式对照）
 *
 *   npx tsx scripts/bench-blind.ts [图片路径...]
 *
 * 不传图片时使用内置的合成图（含大面积平坦天空，是最难的场景）。
 */
import { psnr, type RGBAImage } from "../lib/watermark/core/image"
import { embedSvdQim, extractSvdQim } from "../lib/watermark/blind/baseline-svd-qim"
import { DEFAULT_KEY, embedClassic, extractClassic } from "../lib/watermark/blind/classic"
import { packFrame, type BlindPayload } from "../lib/watermark/blind/payload"
import { ATTACKS, loadRGBA, syntheticPhoto } from "../tests/helpers/image-io"

const payload: BlindPayload = { version: 1, creator: 0xa1b2c3, day: 631, serial: 0x1abc }
const truth = packFrame(payload)

function bitAcc(bits: ArrayLike<number>) {
  let ok = 0
  for (let i = 0; i < truth.length; i++) if (bits[i] === truth[i]) ok++
  return ok / truth.length
}

async function benchOne(label: string, img: RGBAImage) {
  const t0 = performance.now()
  const cdp = embedClassic(img, payload, { key: DEFAULT_KEY, strength: process.env.STRENGTH ? Number(process.env.STRENGTH) : undefined })
  const t1 = performance.now()
  const svd = embedSvdQim(img, payload, { key: DEFAULT_KEY })
  console.log(`\n## ${label}  ${img.width}×${img.height}`)
  console.log(
    `嵌入耗时 CDP ${(t1 - t0).toFixed(0)} ms · PSNR CDP ${psnr(img, cdp).toFixed(2)} dB · SVD-QIM ${psnr(img, svd).toFixed(2)} dB`
  )
  console.log("| 攻击 | CDP 检出 | CDP 得分 | CDP 原始误码 | SVD-QIM 比特准确率 | SVD-QIM CRC |")
  console.log("| --- | --- | --- | --- | --- | --- |")
  for (const atk of ATTACKS) {
    const a = await atk.run(cdp)
    const r = extractClassic(a, { key: DEFAULT_KEY })
    const exact = r.found && r.payload?.creator === payload.creator && r.payload.serial === payload.serial
    const b = await atk.run(svd)
    const s = extractSvdQim(b, { key: DEFAULT_KEY })
    console.log(
      `| ${atk.name} | ${exact ? "✅" : r.found ? "⚠️ 错载荷" : "❌"} | ${r.score.toFixed(2)} | ${(r.rawBitErrorRate * 100).toFixed(1)}% | ${(bitAcc(s.bits) * 100).toFixed(1)}% | ${s.crcOk ? "✅" : "❌"} |`
    )
  }
  // 误报检查：未加水印的原图不应被检出
  const clean = extractClassic(img, { key: DEFAULT_KEY })
  console.log(`\n未加水印原图：检出=${clean.found} 得分=${clean.score.toFixed(2)}（应 ≈0.8 且未检出）`)
}

const paths = process.argv.slice(2)
if (paths.length === 0) await benchOne("合成图", syntheticPhoto())
for (const p of paths) await benchOne(p.split("/").pop()!, await loadRGBA(p, 2400))
