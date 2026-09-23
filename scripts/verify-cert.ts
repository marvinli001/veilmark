/**
 * 离线核验版权证书（命令行）：
 *   npm run verify:cert -- 图片 [证书.cert.json] [--source 原图] [--key 私有密钥] [--trust keyId|公钥] [--trustmark] [--json]
 *
 * 全程不联网：Node 自带的 WebCrypto 验签，sharp 解码图片，复用 lib/watermark 的提取代码，
 * 输出与网页相同的核对清单。PNG 内嵌了证书（iTXt veilmark:cert）时可以省略证书参数。
 * 退出码：0 = 没有失败项，1 = 有失败项，2 = 参数或文件错误。
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import sharp from "sharp"

import type { OrtModule, TrustMarkSessions } from "../lib/watermark/blind/trustmark"
import { checkCertificate, formatReport, SIGNATURE_DISCLAIMER, type CertificateReport } from "../lib/watermark/certificate"
import { fromBase64Url, sha256Hex } from "../lib/watermark/core/bytes"
import { keyIdFromPublicKey } from "../lib/watermark/identity"
import { canonicalFileBytes, readITXt } from "../lib/watermark/png-meta"
import { fingerprintFromHits, verifyImage } from "../lib/watermark/verify"

export interface CliOptions {
  image: string
  cert?: string
  source?: string
  keys: string[]
  trust: string[]
  trustmark: boolean
  json: boolean
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { image: "", keys: [], trust: [], trustmark: false, json: false }
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 需要一个值`)
      return v
    }
    if (a === "--source") o.source = next()
    else if (a === "--key") o.keys.push(next())
    else if (a === "--trust") o.trust.push(next())
    else if (a === "--trustmark") o.trustmark = true
    else if (a === "--json") o.json = true
    else if (a.startsWith("--")) throw new Error(`未知参数 ${a}`)
    else pos.push(a)
  }
  if (!pos[0]) throw new Error("用法：npm run verify:cert -- 图片 [证书.cert.json] [--source 原图] [--key 私钥] [--trust keyId]")
  o.image = pos[0]
  o.cert = pos[1]
  return o
}

/** 可选的 TrustMark：需要自行安装 onnxruntime-node，并已下载模型到 public/models/trustmark */
async function loadTrustMarkNode(): Promise<{ ort: OrtModule; sessions: TrustMarkSessions } | string> {
  try {
    const name = "onnxruntime-node"
    const ort = (await import(name)) as OrtModule
    const { loadTrustMark } = await import("../lib/watermark/blind/trustmark")
    const dir = path.resolve(import.meta.dirname, "../public/models/trustmark")
    return { ort, sessions: await loadTrustMark(ort, dir, { withEncoder: false, providers: ["cpu"] }) }
  } catch (e) {
    return `TrustMark 不可用（${e instanceof Error ? e.message.split("\n")[0] : e}）：需要 npm i onnxruntime-node 并运行 npm run models:trustmark`
  }
}

export async function verifyFiles(o: CliOptions): Promise<CertificateReport & { certSource: string }> {
  const bytes = new Uint8Array(await readFile(o.image))
  const embedded = await readITXt(bytes)
  const sidecar = o.cert ? await readFile(o.cert, "utf8") : null
  const text = sidecar ?? embedded
  if (!text) throw new Error("没有证书：图片里没有内嵌 veilmark:cert，也没有提供 .cert.json")
  let cert: unknown
  try {
    cert = JSON.parse(text)
  } catch {
    throw new Error("证书不是合法的 JSON")
  }
  const c = cert as { payloadHex?: string; watermark?: { engines?: string }; creator?: { publicKey?: string } }

  const { data, info } = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
  const needsTM = o.trustmark || c.watermark?.engines === "trustmark"
  const tm = needsTM ? await loadTrustMarkNode() : undefined
  const hits = await verifyImage(img, { keys: o.keys, trustmark: typeof tm === "object" ? tm : undefined })
  const extracted = fingerprintFromHits(hits, c.payloadHex)

  // 信任：--trust 可以给 keyId 或完整公钥；给 keyId 时按证书公钥重新计算 keyId 再比对
  let trusted: { publicKey: string; label: string } | null = null
  if (c.creator?.publicKey && /^[A-Za-z0-9_-]{43}$/.test(c.creator.publicKey)) {
    const keyId = await keyIdFromPublicKey(fromBase64Url(c.creator.publicKey))
    const hit = o.trust.find((t) => t.replace(/-/g, "").toLowerCase() === keyId || t === c.creator!.publicKey)
    if (hit) trusted = { publicKey: c.creator.publicKey, label: "命令行 --trust" }
  }

  const references = sidecar && embedded && sidecar !== embedded ? [{ label: "图片内嵌证书", cert: JSON.parse(embedded) }] : []
  const report = await checkCertificate({
    cert,
    image: {
      sha256: await sha256Hex(canonicalFileBytes(bytes)),
      width: img.width,
      height: img.height,
      extracted: {
        ...extracted,
        ...(!extracted.payloadHex && typeof tm === "string" && c.watermark?.engines === "trustmark" ? { unavailable: tm } : {}),
      },
    },
    sourceSha256: o.source ? await sha256Hex(new Uint8Array(await readFile(o.source))) : undefined,
    trusted,
    references,
    privateKeyProvided: o.keys.length > 0,
  })
  return { ...report, certSource: sidecar ? (embedded ? "证书文件（图片内另有内嵌证书）" : "证书文件") : "图片内嵌（PNG iTXt）" }
}

async function main() {
  let o: CliOptions
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  }
  try {
    const r = await verifyFiles(o)
    if (o.json) console.log(JSON.stringify(r, null, 2))
    else {
      console.log(`来源：${r.certSource}`)
      console.log(formatReport(r))
      console.log(`\n说明：${SIGNATURE_DISCLAIMER}`)
    }
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    console.error(`核验失败：${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
