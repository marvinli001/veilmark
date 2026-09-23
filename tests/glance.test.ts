import { describe, expect, it } from "vitest"

import { createPlane, resizePlane, resizeRGBA, type RGBAImage } from "../lib/watermark/core/image"
import { applyGlance } from "../lib/watermark/glance/cpu"
import { simulateReveal } from "../lib/watermark/glance/simulate"
import { glancePreset } from "../lib/watermark/glance/types"

/** 中灰平图 + 左半边为“信息区”的掩膜：最干净地度量隐蔽性与显形度 */
function fixture() {
  const W = 512
  const H = 256
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128
    data[i + 1] = 124
    data[i + 2] = 120
    data[i + 3] = 255
  }
  const mask = createPlane(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask.data[y * W + x] = 1
  return { img: { width: W, height: H, data } as RGBAImage, mask }
}

function halfContrast(img: RGBAImage) {
  const small = resizeRGBA(img, img.width / 4, img.height / 4) // 模拟适屏缩略（面积平均）
  const w = small.width
  let l = 0
  let r = 0
  let nl = 0
  let nr = 0
  for (let y = 4; y < small.height - 4; y++)
    for (let x = 4; x < w - 4; x++) {
      if (Math.abs(x - w / 2) < 6) continue
      const i = (y * w + x) * 4
      const Y = 0.299 * small.data[i] + 0.587 * small.data[i + 1] + 0.114 * small.data[i + 2]
      if (x < w / 2) {
        l += Y
        nl++
      } else {
        r += Y
        nr++
      }
    }
  return Math.abs(l / nl - r / nr)
}

describe("伪隐性水印", () => {
  it("高频层在适屏缩略下不可见（两区亮度差 < 0.5 级）", () => {
    const { img, mask } = fixture()
    const cfg = { ...glancePreset("print"), feather: 0, adaptive: 0 }
    cfg.tone.enabled = false
    cfg.chroma.enabled = false
    const out = applyGlance(img, mask, cfg)
    expect(halfContrast(out)).toBeLessThan(0.5)
  })

  it("最近邻重采样后相位光栅显形（两区亮度差 > 5 级）", () => {
    const { img, mask } = fixture()
    const cfg = { ...glancePreset("print"), feather: 0, adaptive: 0 }
    cfg.tone.enabled = false
    cfg.chroma.enabled = false
    cfg.pantograph.enabled = false
    const out = simulateReveal(applyGlance(img, mask, cfg), "nearest-50")
    expect(halfContrast(out)).toBeGreaterThan(5)
  })

  it("等亮度色度层不改变 BT.601 亮度均值", () => {
    const { img, mask } = fixture()
    const cfg = { ...glancePreset("daily"), feather: 0, adaptive: 0 }
    cfg.tone.enabled = false
    cfg.chroma.axis = "blue-yellow"
    expect(halfContrast(applyGlance(img, mask, cfg))).toBeLessThan(0.6)
  })

  it("掩膜与图同尺寸时 resizePlane 不改变数据", () => {
    const p = createPlane(8, 8, 3)
    expect(resizePlane(p, 8, 8).data).toEqual(p.data)
  })
})
