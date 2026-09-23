import { describe, expect, it } from "vitest"

import { payloadToHex, type BlindPayload } from "../lib/watermark/blind/payload"
import {
  canonicalize,
  checkCertificate,
  signCertificate,
  verifyCertificateSignature,
  type Certificate,
  type CertificateBody,
} from "../lib/watermark/certificate"
import {
  createIdentity,
  creatorIdFromPublicKey,
  keyIdFromPublicKey,
  restoreIdentity,
  signWithIdentity,
} from "../lib/watermark/identity"
import { fromBase64Url } from "../lib/watermark/core/bytes"

describe("RFC 8785 JCS 规范化", () => {
  it("RFC 8785 §3.2.4 示例：数字与字符串序列化", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}'
    )
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
    )
  })

  it("RFC 8785 §3.2.3 示例：按 UTF-16 码元排序键", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    }
    // 不能用 JSON.parse 再取 Object.values：JS 对象会把整数键 "1" 提到最前
    const out = canonicalize(input)
    const order = [...out.matchAll(/:"([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ])
  })

  it("与键顺序、空白无关；拒绝 NaN/Infinity；-0 规范为 0", () => {
    expect(canonicalize({ b: [1, { y: 2, x: 1 }], a: "中" })).toBe(canonicalize(JSON.parse('{ "a" : "中", "b":[1,{"x":1,"y":2}] }')))
    expect(() => canonicalize({ x: Number.NaN })).toThrow()
    expect(() => canonicalize([Infinity])).toThrow()
    expect(canonicalize(-0)).toBe("0")
  })
})

const payload: BlindPayload = { version: 1, creator: 0x123456, day: 996, serial: 77 }

async function issue(): Promise<{ cert: Certificate; publicKey: Uint8Array }> {
  const { record } = await createIdentity("Marvin Studio")
  const publicKey = fromBase64Url(record.publicKey)
  const body: CertificateBody = {
    type: "veilmark.certificate/v1",
    payloadHex: payloadToHex(payload),
    payload,
    creator: { name: record.name, publicKey: record.publicKey, keyId: record.keyId },
    work: { fileName: "fjord_wm.png", sourceSha256: "a".repeat(64), outputSha256: "b".repeat(64), width: 2400, height: 1600 },
    watermark: { engines: "cdp", keyMode: "public" },
    issuedAt: "2026-09-23T08:00:00.000Z",
  }
  return { cert: await signCertificate(body, (m) => signWithIdentity(record, m)), publicKey }
}

/** 证书的每一个叶子字段路径（signature 除外） */
function leafPaths(v: unknown, prefix = ""): string[] {
  if (typeof v === "object" && v !== null)
    return Object.entries(v).flatMap(([k, x]) => leafPaths(x, prefix ? `${prefix}.${k}` : k))
  return prefix === "signature" ? [] : [prefix]
}

function tamper(cert: Certificate, path: string): Certificate {
  const c = structuredClone(cert) as unknown as Record<string, unknown>
  const keys = path.split(".")
  let o = c as Record<string, unknown>
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>
  const last = keys.at(-1)!
  const v = o[last]
  o[last] = typeof v === "number" ? v + 1 : typeof v === "string" ? (v.length ? v.slice(0, -1) + (v.at(-1) === "a" ? "b" : "a") : "x") : v
  return c as unknown as Certificate
}

describe("证书签名", () => {
  it("签名/验签往返；keyId 为公钥 SHA-256 前 16 位", async () => {
    const { cert, publicKey } = await issue()
    expect(await verifyCertificateSignature(cert)).toBe(true)
    expect(cert.creator.keyId).toBe(await keyIdFromPublicKey(publicKey))
    expect(cert.creator.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(cert.signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
  })

  it("签名覆盖 JCS 规范形式：键顺序变化不影响验签", async () => {
    const { cert } = await issue()
    // 递归倒转所有对象的键顺序，模拟别的工具重新序列化过的证书
    const reverse = (v: unknown): unknown =>
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]))
        : v
    const shuffled = reverse(JSON.parse(JSON.stringify(cert))) as Certificate
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(cert))
    expect(await verifyCertificateSignature(shuffled)).toBe(true)
  })

  it("篡改任一字段后验签失败", async () => {
    const { cert } = await issue()
    const paths = leafPaths(cert)
    expect(paths.length).toBeGreaterThanOrEqual(17)
    for (const p of paths) {
      const t = tamper(cert, p)
      expect(await verifyCertificateSignature(t), p).toBe(false)
      const r = await checkCertificate({ cert: t })
      expect(r.ok, p).toBe(false)
      expect(r.items.find((i) => i.id === "signature")?.status, p).toBe("fail")
    }
  })

  it("篡改后能借助参考副本点名被改的字段", async () => {
    const { cert } = await issue()
    const t = tamper(cert, "work.outputSha256")
    const r = await checkCertificate({ cert: t, references: [{ label: "本地注册表", cert }] })
    expect(r.items.find((i) => i.id === "signature")?.fields).toEqual(["work.outputSha256"])
  })

  it("改动指纹同时改签名也无济于事；内部一致性检查直接点名矛盾字段", async () => {
    const { cert } = await issue()
    const t = { ...cert, payloadHex: "00000000000000" }
    const r = await checkCertificate({ cert: t })
    expect(r.items.find((i) => i.id === "consistency")?.fields).toContain("payloadHex")
  })

  it("完整清单：同一文件 + 指纹一致 + 已信任 + 原图一致 → 全部通过", async () => {
    const { cert } = await issue()
    const r = await checkCertificate({
      cert,
      image: { sha256: "b".repeat(64), width: 2400, height: 1600, extracted: { payloadHex: cert.payloadHex } },
      sourceSha256: "a".repeat(64),
      trusted: { publicKey: cert.creator.publicKey, label: "Marvin" },
    })
    expect(r.items.map((i) => [i.id, i.status])).toEqual([
      ["signature", "pass"],
      ["trust", "pass"],
      ["fingerprint", "pass"],
      ["file", "pass"],
      ["source", "pass"],
      ["consistency", "pass"],
    ])
    expect(r.ok).toBe(true)
  })

  it("证书不属于这张图：指纹不符判失败", async () => {
    const { cert } = await issue()
    const r = await checkCertificate({
      cert,
      image: { sha256: "c".repeat(64), width: 100, height: 100, extracted: { payloadHex: "0123456789abcd" } },
    })
    expect(r.items.find((i) => i.id === "fingerprint")?.status).toBe("fail")
    expect(r.items.find((i) => i.id === "file")?.status).toBe("warn")
    expect(r.ok).toBe(false)
  })
})

describe("签名身份", () => {
  it("加密备份 → 口令恢复得到同一把密钥；错误口令被拒绝", async () => {
    const { record, backup } = await createIdentity("备份测试", { passphrase: "correct horse battery" })
    expect(backup).toBeTruthy()
    const file = JSON.parse(backup!)
    expect(file.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: 600_000 })
    expect(file.cipher.name).toBe("AES-GCM")
    const restored = await restoreIdentity(backup!, "correct horse battery")
    expect(restored.publicKey).toBe(record.publicKey)
    expect(restored.keyId).toBe(record.keyId)
    // 恢复出的私钥能签出可被原公钥验证的签名
    const msg = new TextEncoder().encode("hello")
    const sig = await signWithIdentity(restored, msg)
    const { verifyEd25519 } = await import("../lib/watermark/identity")
    expect(await verifyEd25519(fromBase64Url(record.publicKey), sig, msg)).toBe(true)
    await expect(restoreIdentity(backup!, "wrong passphrase")).rejects.toThrow()
  }, 20_000)

  it("创作者 ID 可由公钥派生（24 bit）", async () => {
    const { record } = await createIdentity("x")
    const id = await creatorIdFromPublicKey(fromBase64Url(record.publicKey))
    expect(id).toBeGreaterThanOrEqual(0)
    expect(id).toBeLessThan(1 << 24)
  })
})
