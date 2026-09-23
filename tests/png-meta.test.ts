import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { DEFAULT_KEY, embedClassic, extractClassic } from "../lib/watermark/blind/classic"
import { payloadToHex } from "../lib/watermark/blind/payload"
import { signCertificate, type CertificateBody } from "../lib/watermark/certificate"
import { sha256Hex } from "../lib/watermark/core/bytes"
import { createIdentity, signWithIdentity } from "../lib/watermark/identity"
import { canonicalFileBytes, crc32, readChunks, readITXt, removeITXt, writeITXt } from "../lib/watermark/png-meta"
import { parseArgs, verifyFiles } from "../scripts/verify-cert"
import { syntheticPhoto, toSharp } from "./helpers/image-io"

const payload = { version: 1, creator: 4242, day: 996, serial: 99 }
const img = syntheticPhoto(960, 640)
const wm = embedClassic(img, payload, { key: DEFAULT_KEY })
const png = new Uint8Array(await toSharp(wm).png().toBuffer())

async function raw(bytes: Uint8Array) {
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return data
}

describe("PNG iTXt", () => {
  it("CRC32 与标准值一致", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082)
  })

  it("写入/读取往返（含中文与 emoji），重复写入会替换而不是追加", async () => {
    const text = JSON.stringify({ hello: "版权证书 ✓ 🖼️" })
    const once = writeITXt(png, text)
    expect(await readITXt(once)).toBe(text)
    const twice = writeITXt(once, text + " ")
    expect(await readITXt(twice)).toBe(text + " ")
    expect(readChunks(twice).filter((c) => c.type === "iTXt")).toHaveLength(1)
    expect(readChunks(twice).every((c) => c.crcOk)).toBe(true)
    expect(readChunks(twice)[1].type).toBe("iTXt") // 紧跟 IHDR
  })

  it("写入后像素不变、盲水印仍可提取；去掉证书块后字节与原文件完全相同", async () => {
    const withCert = writeITXt(png, "{}")
    expect(Buffer.compare(await raw(withCert), await raw(png))).toBe(0)
    const { data, info } = await sharp(withCert).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const r = extractClassic({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) }, { key: DEFAULT_KEY })
    expect(r.found).toBe(true)
    expect(r.payload).toEqual(payload)
    expect(Buffer.compare(Buffer.from(removeITXt(withCert)), Buffer.from(png))).toBe(0)
    expect(await sha256Hex(canonicalFileBytes(withCert))).toBe(await sha256Hex(png))
  })

  it("没有证书块时返回 null；非 PNG 不报错", async () => {
    expect(await readITXt(png)).toBeNull()
    expect(await readITXt(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe("命令行离线核验（与网页相同的清单）", () => {
  it("对一张按导出流程生成的 PNG：内嵌证书、旁路证书两种方式都全部通过", async () => {
    // 与网页导出相同的步骤：嵌入盲水印 → 编码 PNG → 对文件字节签发证书 → 写入 iTXt
    const { record } = await createIdentity("Marvin Studio")
    const source = new Uint8Array(await toSharp(img).png().toBuffer())
    const body: CertificateBody = {
      type: "veilmark.certificate/v1",
      payloadHex: payloadToHex(payload),
      payload,
      creator: { name: record.name, publicKey: record.publicKey, keyId: record.keyId },
      work: {
        fileName: "synthetic_wm.png",
        sourceSha256: await sha256Hex(source),
        outputSha256: await sha256Hex(png),
        width: wm.width,
        height: wm.height,
      },
      watermark: { engines: "cdp", keyMode: "public" },
      issuedAt: "2026-09-23T08:00:00.000Z",
    }
    const cert = await signCertificate(body, (m) => signWithIdentity(record, m))
    const dir = await mkdtemp(path.join(tmpdir(), "veilmark-"))
    const out = path.join(dir, "synthetic_wm.png")
    const src = path.join(dir, "synthetic.png")
    const side = path.join(dir, "synthetic_wm.cert.json")
    await writeFile(out, writeITXt(png, JSON.stringify(cert)))
    await writeFile(src, source)
    await writeFile(side, JSON.stringify(cert, null, 2))

    for (const args of [[out], [out, side]]) {
      const r = await verifyFiles(parseArgs([...args, "--source", src, "--trust", record.keyId]))
      expect(r.items.map((i) => `${i.id}:${i.status}`)).toEqual([
        "signature:pass",
        "trust:pass",
        "fingerprint:pass",
        "file:pass",
        "source:pass",
        "consistency:pass",
      ])
      expect(r.ok).toBe(true)
    }

    // 旁路证书被改过：清单指出签名失败，并借助图片内嵌的原件点名被改字段
    await writeFile(side, JSON.stringify({ ...cert, work: { ...cert.work, fileName: "stolen.png" } }))
    const bad = await verifyFiles(parseArgs([out, side]))
    expect(bad.ok).toBe(false)
    expect(bad.items[0]).toMatchObject({ id: "signature", status: "fail", fields: ["work.fileName"] })
  }, 30_000)
})
