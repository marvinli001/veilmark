import { describe, expect, it } from "vitest"

import { glancePreset } from "../lib/watermark/glance/types"
import { liveMapsKey, liveSupport } from "../lib/watermark/live"
import { defaultJob, type WatermarkJob } from "../lib/watermark/pipeline"

const tpl = { author: "M", filename: "a.jpg", index: 0 }

function job(patch: (j: WatermarkJob) => void = () => {}) {
  const j = defaultJob()
  j.glance = { ...glancePreset("print"), enabled: true }
  patch(j)
  return j
}

describe("实时预览：参数分类", () => {
  const base = liveMapsKey(job(), tpl)

  it("只影响 uniform 的参数不触发底图/掩膜重算", () => {
    const uniformOnly: Array<(j: WatermarkJob) => void> = [
      (j) => (j.glance.grating.amplitude = 9),
      (j) => (j.glance.grating.kind = "lines"),
      (j) => (j.glance.grating.period = 4),
      (j) => (j.glance.grating.angle = 30),
      (j) => (j.glance.pantograph.amplitude = 1),
      (j) => (j.glance.pantograph.coarsePeriod = 8),
      (j) => (j.glance.tone.amplitude = 3),
      (j) => (j.glance.tone.shadowBias = 0.9),
      (j) => (j.glance.chroma.amplitude = 12),
      (j) => (j.glance.chroma.axis = "red-green"),
      (j) => (j.glance.tone.enabled = false),
    ]
    for (const p of uniformOnly) expect(liveMapsKey(job(p), tpl)).toBe(base)
  })

  it("底图/排版相关参数会触发重算", () => {
    const layout: Array<(j: WatermarkJob) => void> = [
      (j) => (j.glance.text.content = "别的字"),
      (j) => (j.glance.text.fontSize = 12),
      (j) => (j.glance.layout.rotation = 10),
      (j) => (j.glance.layout.gapY = 2),
      (j) => (j.glance.feather = 3),
      (j) => (j.glance.adaptive = 0.2),
      (j) => (j.visible[0].opacity = 0.5),
      (j) => (j.author = "someone"),
    ]
    for (const p of layout) expect(liveMapsKey(job(p), { ...tpl, author: undefined })).not.toBe(
      liveMapsKey(job(), { ...tpl, author: undefined })
    )
  })
})

describe("实时预览：能否接管", () => {
  const caps = { webgl2: true, maxTextureSize: 4096 }
  const s = { caps, width: 2400, height: 1600, job: job(), reveal: "none", pinned: false }

  it("正常情况下两类都可接管", () => {
    expect(liveSupport("glance", s).ok).toBe(true)
    expect(liveSupport("visible", s).ok).toBe(true)
  })

  it("不支持 WebGL2 / 超过纹理上限时回退并给出原因；显性层不受影响", () => {
    const noGL = liveSupport("glance", { ...s, caps: { webgl2: false, maxTextureSize: 0 } })
    expect(noGL.ok).toBe(false)
    expect(noGL.reason).toContain("WebGL2")
    const big = liveSupport("glance", { ...s, width: 5000 })
    expect(big.ok).toBe(false)
    expect(big.reason).toContain("4096")
    expect(liveSupport("visible", { ...s, caps: { webgl2: false, maxTextureSize: 0 } }).ok).toBe(true)
    const huge = liveSupport("glance", { ...s, caps: { webgl2: true, maxTextureSize: 16384 }, width: 9000, height: 6000 })
    expect(huge.ok).toBe(false)
  })

  it("盗用模拟、指定了其他模板、伪隐性关闭时不接管", () => {
    expect(liveSupport("glance", { ...s, reveal: "print" }).ok).toBe(false)
    expect(liveSupport("visible", { ...s, pinned: true }).ok).toBe(false)
    expect(liveSupport("glance", { ...s, job: job((j) => (j.glance.enabled = false)) }).ok).toBe(false)
  })
})
