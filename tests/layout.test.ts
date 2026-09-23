import { describe, expect, it } from "vitest"

import { computePlacements, resolveTemplate } from "../lib/watermark/visible/layout"
import { defaultLayer } from "../lib/watermark/visible/types"

describe("排版引擎", () => {
  it("单点右下角贴边且不越界", () => {
    const spec = { ...defaultLayer("a").layout, mode: "single" as const, anchor: "bottom-right" as const, rotation: 0, margin: 2 }
    const [p] = computePlacements(spec, 1000, 800, 200, 50)
    expect(p.x + 100).toBeLessThanOrEqual(1000)
    expect(p.y + 25).toBeLessThanOrEqual(800)
    expect(1000 - (p.x + 100)).toBeCloseTo(16, 0) // 2% × 短边 800
  })

  it("平铺覆盖四角", () => {
    const spec = { ...defaultLayer("a").layout, mode: "tile" as const, rotation: -30 }
    const ps = computePlacements(spec, 1200, 800, 160, 40)
    const near = (x: number, y: number) => ps.some((p) => Math.hypot(p.x - x, p.y - y) < 260)
    expect(near(0, 0) && near(1200, 0) && near(0, 800) && near(1200, 800)).toBe(true)
  })

  it("smart 锚点选择代价最小的位置", () => {
    const spec = { ...defaultLayer("a").layout, mode: "single" as const, anchor: "smart" as const, rotation: 0 }
    const [p] = computePlacements(spec, 1000, 800, 100, 40, (a) => (a === "top-left" ? 0 : 10))
    expect(p.x).toBeLessThan(500)
    expect(p.y).toBeLessThan(400)
  })

  it("模板变量替换，未知变量保留", () => {
    const s = resolveTemplate("© {author} · {filename} #{index} {nope}", { author: "M", filename: "a.jpg", index: 0 })
    expect(s).toBe("© M · a #001 {nope}")
  })
})
