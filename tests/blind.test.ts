import { describe, expect, it } from "vitest"

import { DEFAULT_KEY, embedClassic, extractClassic } from "../lib/watermark/blind/classic"
import { psnr } from "../lib/watermark/core/image"
import { ATTACKS, syntheticPhoto } from "./helpers/image-io"

const payload = { version: 1, creator: 4242, day: 700, serial: 99 }
const img = syntheticPhoto(1280, 853)
const wm = embedClassic(img, payload, { key: DEFAULT_KEY })

describe("CDP 盲水印", () => {
  it("画质：PSNR > 36 dB", () => {
    expect(psnr(img, wm)).toBeGreaterThan(36)
  })

  it("无攻击时正确提取", () => {
    const r = extractClassic(wm, { key: DEFAULT_KEY })
    expect(r.found).toBe(true)
    expect(r.payload).toEqual(payload)
  })

  it("未加水印的图不误报", () => {
    const r = extractClassic(img, { key: DEFAULT_KEY })
    expect(r.found).toBe(false)
    expect(r.score).toBeLessThan(1.5)
  })

  it("错误密钥无法检出", () => {
    expect(extractClassic(wm, { key: "someone-else" }).found).toBe(false)
  })

  const mustSurvive = ["JPEG q50", "缩放 25%", "截图(60%+边框)", "对比度 ×1.25", "Gamma 0.8", "亮度 +10", "高斯模糊 σ=1.5"]
  for (const name of mustSurvive) {
    it(`抗攻击：${name}`, async () => {
      const attacked = await ATTACKS.find((a) => a.name === name)!.run(wm)
      const r = extractClassic(attacked, { key: DEFAULT_KEY })
      expect(r.found).toBe(true)
      expect(r.payload).toEqual(payload)
    })
  }
})
