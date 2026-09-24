import { describe, expect, it } from "vitest"

import { createPlane, resizePlane, resizeRGBA, type RGBAImage } from "../lib/watermark/core/image"
import { applyGlance } from "../lib/watermark/glance/cpu"
import { simulateReveal } from "../lib/watermark/glance/simulate"
import { glanceMaskStyle, glancePreset, type GlanceConfig } from "../lib/watermark/glance/types"

/** 中灰平图 + 左半边为“信息区”的掩膜：最干净地度量隐蔽性与显形度 */
function fixture(rgb: [number, number, number] = [128, 124, 120]) {
  const W = 512
  const H = 256
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
    data[i + 3] = 255
  }
  const mask = createPlane(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask.data[y * W + x] = 1
  return { img: { width: W, height: H, data } as RGBAImage, mask }
}

/** 两半区的均值差；measure 默认取 BT.601 亮度 */
function halfContrast(img: RGBAImage, measure = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b) {
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
      const Y = measure(small.data[i], small.data[i + 1], small.data[i + 2])
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

  it("打印+截图：打印层与 print 一致，低频层明显强于 print", () => {
    const { img, mask } = fixture()
    const hybrid = glancePreset("hybrid")
    const print = glancePreset("print")
    expect(hybrid.grating).toEqual(print.grating)
    expect(hybrid.pantograph).toEqual(print.pantograph)
    // 截图≈适屏缩略：高频层被平均掉，留下来的只有低频层
    const lowOnly = (c: GlanceConfig): GlanceConfig => ({
      ...c,
      feather: 0,
      adaptive: 0,
      grating: { ...c.grating, enabled: false },
      pantograph: { ...c.pantograph, enabled: false },
    })
    const h = halfContrast(applyGlance(img, mask, lowOnly(hybrid)))
    const p = halfContrast(applyGlance(img, mask, lowOnly(print)))
    expect(h).toBeGreaterThan(1.5 * p)
  })

  /** 只开光栅（含色度路），其余层关闭 */
  const gratingOnly = (chroma: number): GlanceConfig => {
    const c = { ...glancePreset("hybrid"), feather: 0, adaptive: 0 }
    return {
      ...c,
      grating: { ...c.grating, chroma },
      pantograph: { ...c.pantograph, enabled: false },
      tone: { ...c.tone, enabled: false },
      chroma: { ...c.chroma, enabled: false },
    }
  }
  const blueMinusRed = (r: number, _g: number, b: number) => b - r

  it("光栅色度路：适屏缩略下亮度与色度都不可见，最近邻后色差远大于亮度光栅", () => {
    const { img, mask } = fixture()
    const out = applyGlance(img, mask, gratingOnly(16))
    expect(halfContrast(out)).toBeLessThan(0.5)
    expect(halfContrast(out, blueMinusRed)).toBeLessThan(0.6)
    const revealed = simulateReveal(out, "nearest-50")
    // 两区各 ±16（B），再加 R 的 ∓2 → B−R 差约 2×18
    expect(halfContrast(revealed, blueMinusRed)).toBeGreaterThan(25)
    expect(halfContrast(simulateReveal(applyGlance(img, mask, gratingOnly(0)), "nearest-50"), blueMinusRed)).toBeLessThan(1)
  })

  it("光栅色度路在接近饱和的颜色上按对称余量降幅，不因截断在适屏下露出", () => {
    // 与防复印底纹叠加时两区的通道振幅不同，截断不对称才会漏出字形（去掉余量时 ΔC 为 1–2 级）
    const cfg = gratingOnly(24)
    cfg.pantograph.enabled = true
    for (const rgb of [[250, 250, 250], [20, 40, 250], [240, 200, 6], [8, 10, 12], [60, 60, 238]] as [number, number, number][]) {
      const { img, mask } = fixture(rgb)
      const out = applyGlance(img, mask, cfg)
      expect(halfContrast(out)).toBeLessThan(0.1)
      expect(halfContrast(out, blueMinusRed)).toBeLessThan(0.5)
    }
  })

  it("打印显形与打印+截图预设开启色度光栅与掩膜加粗", () => {
    for (const mode of ["print", "hybrid"] as const) {
      expect(glancePreset(mode).grating.chroma).toBeGreaterThan(0)
      expect(glancePreset(mode).bold).toBeGreaterThan(0)
    }
    const style = glanceMaskStyle(glancePreset("hybrid"))
    expect(style.stroke).toEqual({ enabled: true, color: "#fff", width: glancePreset("hybrid").bold })
    expect(glanceMaskStyle(glancePreset("daily")).stroke.enabled).toBe(false)
  })

  it("掩膜与图同尺寸时 resizePlane 不改变数据", () => {
    const p = createPlane(8, 8, 3)
    expect(resizePlane(p, 8, 8).data).toEqual(p.data)
  })
})
