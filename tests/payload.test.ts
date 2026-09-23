import { describe, expect, it } from "vitest"

import { FRAME_BITS, creatorIdFromText, packFrame, payloadToHex, unpackFrame } from "../lib/watermark/blind/payload"

const p = { version: 1, creator: 0xa1b2c3, day: 631, serial: 0x1abc }

describe("payload", () => {
  it("帧往返一致且 CRC 通过", () => {
    const bits = packFrame(p)
    expect(bits.length).toBe(FRAME_BITS)
    const { payload, crcOk } = unpackFrame(bits)
    expect(crcOk).toBe(true)
    expect(payload).toEqual(p)
  })

  it("任意单比特翻转都会被 CRC 检出", () => {
    const bits = packFrame(p)
    for (let i = 0; i < FRAME_BITS; i++) {
      const b = bits.slice()
      b[i] ^= 1
      expect(unpackFrame(b).crcOk).toBe(false)
    }
  })

  it("数字创作者 ID 直写，文本折叠为 24 bit", () => {
    expect(creatorIdFromText("12345")).toBe(12345)
    const h = creatorIdFromText("Marvin Studio")
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(1 << 24)
    expect(creatorIdFromText(" Marvin Studio ")).toBe(h)
  })

  it("指纹为 14 位十六进制", () => {
    expect(payloadToHex(p)).toMatch(/^[0-9a-f]{14}$/)
  })

  it("越界字段抛错", () => {
    expect(() => packFrame({ ...p, serial: 1 << 14 })).toThrow()
  })
})
