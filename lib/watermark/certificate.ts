import { dayFromDate, payloadToHex, type BlindPayload } from "./blind/payload"
import { fromBase64Url, toBase64Url, utf8 } from "./core/bytes"
import { creatorIdFromPublicKey, formatKeyId, keyIdFromPublicKey, verifyEd25519 } from "./identity"
import type { BlindEngine } from "./pipeline"

/**
 * 可离线验证的版权证书（veilmark.certificate/v1）。
 *
 * 证书把三样东西绑在一起，并由创作者的 Ed25519 密钥签名：
 *   图中盲水印指纹 payloadHex ↔ 创作者公钥 ↔ 作品文件哈希（原图 / 导出文件）
 * 签名对象是去掉 signature 字段后、按 RFC 8785（JCS）规范化的 JSON 的 UTF-8 字节。
 *
 * 含义边界（UI 与文档同样写明）：签名只证明“这把密钥的持有者在 issuedAt 时自行声明了这些内容”，
 * 不是可信时间戳，也不是法律意义上的权属认定。可信时间戳（RFC 3161 / OpenTimestamps）与 C2PA 见路线图。
 */

export const CERT_TYPE = "veilmark.certificate/v1"

export interface CertificateBody {
  type: typeof CERT_TYPE
  payloadHex: string
  payload: BlindPayload
  creator: { name: string; publicKey: string; keyId: string }
  work: {
    fileName: string
    sourceSha256: string
    /** 导出文件字节的 SHA-256；PNG 内嵌证书时，按“去掉 veilmark:cert 块后”的字节计算 */
    outputSha256: string
    width: number
    height: number
  }
  /** 只记录模式，绝不写入密钥本身 */
  watermark: { engines: BlindEngine; keyMode: "public" | "private" }
  issuedAt: string
}

export interface Certificate extends CertificateBody {
  /** base64url 编码的 64 字节 Ed25519 签名 */
  signature: string
}

// ---------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme
// ---------------------------------------------------------------------------

/**
 * JCS 规范化：
 * - 对象键按 UTF-16 码元排序（即 JS 默认的字符串排序），无多余空白；
 * - 字符串与数字的序列化沿用 ECMAScript JSON.stringify（RFC 8785 正是以它为准）；
 * - NaN / Infinity 不是合法 JSON，直接拒绝；值为 undefined 的属性与 JSON 一样省略。
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS 不接受 NaN / Infinity")
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`
  }
  throw new TypeError(`JCS 不支持的类型：${typeof value}`)
}

/** 签名输入：去掉 signature 后的 JCS 字节 */
export function signingInput(cert: CertificateBody | Certificate): Uint8Array {
  const { signature: _drop, ...body } = cert as Certificate
  void _drop
  return utf8(canonicalize(body))
}

export async function signCertificate(
  body: CertificateBody,
  sign: (message: Uint8Array) => Promise<Uint8Array>
): Promise<Certificate> {
  const signature = await sign(signingInput(body))
  return { ...body, signature: toBase64Url(signature) }
}

export async function verifyCertificateSignature(cert: Certificate): Promise<boolean> {
  try {
    return await verifyEd25519(fromBase64Url(cert.creator.publicKey), fromBase64Url(cert.signature), signingInput(cert))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 结构校验与一致性
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const B64URL = /^[A-Za-z0-9_-]+$/

/** 结构校验：返回有问题的字段路径（空数组表示结构合法） */
export function validateCertificate(v: unknown): string[] {
  const bad: string[] = []
  if (!isObj(v)) return ["(根)"]
  const need = (ok: boolean, path: string) => void (ok || bad.push(path))
  need(v.type === CERT_TYPE, "type")
  need(typeof v.payloadHex === "string" && /^[0-9a-f]{14}$/.test(v.payloadHex), "payloadHex")
  const p = isObj(v.payload) ? v.payload : {}
  for (const [k, bits] of [
    ["version", 3],
    ["creator", 24],
    ["day", 15],
    ["serial", 14],
  ] as const)
    need(Number.isInteger(p[k]) && (p[k] as number) >= 0 && (p[k] as number) < 2 ** bits, `payload.${k}`)
  const c = isObj(v.creator) ? v.creator : {}
  need(typeof c.name === "string", "creator.name")
  need(typeof c.publicKey === "string" && B64URL.test(c.publicKey) && c.publicKey.length === 43, "creator.publicKey")
  need(typeof c.keyId === "string" && /^[0-9a-f]{16}$/.test(c.keyId), "creator.keyId")
  const w = isObj(v.work) ? v.work : {}
  need(typeof w.fileName === "string", "work.fileName")
  need(typeof w.sourceSha256 === "string" && HEX64.test(w.sourceSha256), "work.sourceSha256")
  need(typeof w.outputSha256 === "string" && HEX64.test(w.outputSha256), "work.outputSha256")
  need(Number.isInteger(w.width) && (w.width as number) > 0, "work.width")
  need(Number.isInteger(w.height) && (w.height as number) > 0, "work.height")
  const m = isObj(v.watermark) ? v.watermark : {}
  need(m.engines === "cdp" || m.engines === "trustmark" || m.engines === "dual", "watermark.engines")
  need(m.keyMode === "public" || m.keyMode === "private", "watermark.keyMode")
  need(typeof v.issuedAt === "string" && !Number.isNaN(Date.parse(v.issuedAt)), "issuedAt")
  need(typeof v.signature === "string" && B64URL.test(v.signature) && v.signature.length === 86, "signature")
  return bad
}

/** 两份证书逐叶子字段比较，返回不同的路径（用于定位被改动的字段） */
export function diffCertificates(a: unknown, b: unknown, prefix = ""): string[] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => diffCertificates(a[k], b[k], prefix ? `${prefix}.${k}` : k))
  }
  return canonicalize(a ?? null) === canonicalize(b ?? null) ? [] : [prefix || "(根)"]
}

// ---------------------------------------------------------------------------
// 逐项核对清单（网页与命令行共用）
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn" | "skip"

export interface CheckItem {
  id: "signature" | "trust" | "fingerprint" | "file" | "source" | "consistency"
  title: string
  status: CheckStatus
  detail: string
  /** 能定位到的问题字段 */
  fields?: string[]
}

export interface ExtractedFingerprint {
  /** 未检出时为 null */
  payloadHex: string | null
  /** 例如 “CDP · 公开密钥 · 得分 7.1” */
  detail?: string
  /** 无法按证书声明的引擎提取时的原因（例如命令行没有 TrustMark 运行时） */
  unavailable?: string
}

export interface CertificateCheckInput {
  cert: unknown
  /** 待核验的图片：文件哈希（PNG 已去掉证书块）、尺寸与提取出的指纹 */
  image?: { sha256: string; width: number; height: number; extracted: ExtractedFingerprint }
  /** 用户另外提供的原图哈希 */
  sourceSha256?: string
  /** 本地信任列表里与该 keyId 对应的公钥（未信任为 null） */
  trusted?: { publicKey: string; label: string } | null
  /** 可选的参考副本（注册表里的原件、图片内嵌 vs 旁路文件），签名失败时用来定位被改动的字段 */
  references?: Array<{ label: string; cert: unknown }>
  /** 证书为私有密钥模式时，验证方是否提供了密钥 */
  privateKeyProvided?: boolean
}

export interface CertificateReport {
  ok: boolean
  items: CheckItem[]
  cert: Certificate | null
}

const TITLES: Record<CheckItem["id"], string> = {
  signature: "签名有效",
  trust: "公钥已信任",
  fingerprint: "图中指纹与证书一致",
  file: "与导出文件为同一文件",
  source: "原图哈希一致",
  consistency: "证书内部一致",
}

export async function checkCertificate(input: CertificateCheckInput): Promise<CertificateReport> {
  const items: CheckItem[] = []
  const add = (id: CheckItem["id"], status: CheckStatus, detail: string, fields?: string[]) =>
    items.push({ id, title: TITLES[id], status, detail, ...(fields?.length ? { fields } : {}) })

  const invalid = validateCertificate(input.cert)
  if (invalid.length) {
    add("signature", "fail", "证书结构不完整或字段格式不对，无法验签", invalid)
    return { ok: false, items, cert: null }
  }
  const cert = input.cert as Certificate
  const publicKey = fromBase64Url(cert.creator.publicKey)

  // 1. 签名
  const sigOk = await verifyCertificateSignature(cert)
  if (sigOk) add("signature", "pass", "Ed25519 签名与证书内容吻合，证书自签发后未被改动")
  else {
    const changed = [
      ...new Set(
        (input.references ?? []).flatMap((r) => diffCertificates(r.cert, cert).filter((f) => f !== "signature"))
      ),
    ]
    const hint = changed.length
      ? `与参考副本（${(input.references ?? []).map((r) => r.label).join("、")}）比对，以下字段被改动`
      : "证书内容与签名不符：至少有一个字段在签发后被改动（没有参考副本时无法精确定位，可结合下方一致性检查）"
    add("signature", "fail", hint, changed)
  }

  // 6. 内部一致性：这些检查不依赖签名，能直接点名被改的字段
  const inconsistent: string[] = []
  const notes: string[] = []
  if (payloadToHex(cert.payload) !== cert.payloadHex) inconsistent.push("payloadHex", "payload")
  if ((await keyIdFromPublicKey(publicKey)) !== cert.creator.keyId) inconsistent.push("creator.keyId")
  // 指纹日期取自处理时刻，证书在导出时签发，可以晚很多（补签旧作品），但不可能早于指纹日期（留 1 天时区余量）
  const issuedDay = dayFromDate(new Date(cert.issuedAt))
  if (issuedDay < cert.payload.day - 1) inconsistent.push("issuedAt", "payload.day")
  if ((await creatorIdFromPublicKey(publicKey)) === cert.payload.creator) notes.push("指纹中的创作者 ID 由该公钥派生，指纹与密钥绑定")
  else notes.push("创作者 ID 未由公钥派生（指纹与密钥未绑定）")
  add(
    "consistency",
    inconsistent.length ? "fail" : "pass",
    inconsistent.length ? "以下字段彼此矛盾（指纹应由载荷字段编码而来、keyId 应由公钥算出、签发日期不应早于指纹日期）" : notes.join("；"),
    inconsistent
  )

  // 2. 公钥信任
  if (inconsistent.includes("creator.keyId")) add("trust", "fail", "keyId 与公钥不符，无法据此比对", ["creator.keyId"])
  else if (input.trusted && input.trusted.publicKey === cert.creator.publicKey)
    add("trust", "pass", `已信任的公钥「${input.trusted.label}」· keyId ${formatKeyId(cert.creator.keyId)}`)
  else if (input.trusted)
    add("trust", "fail", `keyId 相同但公钥不同（疑似伪造）：${formatKeyId(cert.creator.keyId)}`, ["creator.publicKey"])
  else
    add(
      "trust",
      "warn",
      `尚未信任此公钥。请通过线下渠道向「${cert.creator.name || "作者"}」核对 keyId：${formatKeyId(cert.creator.keyId)}`
    )

  // 3. 图中指纹
  if (!input.image) add("fingerprint", "skip", "未提供图片")
  else if (input.image.extracted.payloadHex === cert.payloadHex)
    add("fingerprint", "pass", `从图中提取到 ${cert.payloadHex}${input.image.extracted.detail ? `（${input.image.extracted.detail}）` : ""}`)
  else if (input.image.extracted.payloadHex)
    add(
      "fingerprint",
      "fail",
      `图中指纹 ${input.image.extracted.payloadHex} 与证书 ${cert.payloadHex} 不符：证书不属于这张图`,
      ["payloadHex"]
    )
  else if (cert.watermark.keyMode === "private" && !input.privateKeyProvided)
    add("fingerprint", "warn", "证书声明使用私有密钥嵌入，请提供创作者的私有密钥后重试")
  else if (input.image.extracted.unavailable) add("fingerprint", "warn", input.image.extracted.unavailable)
  else add("fingerprint", "fail", "未能从图中提取盲水印，无法把证书与这张图绑定（图片可能被裁剪或严重压缩）")

  // 4. 文件哈希
  if (!input.image) add("file", "skip", "未提供图片")
  else if (input.image.sha256 === cert.work.outputSha256) add("file", "pass", "文件字节与导出时完全相同：同一文件")
  else {
    const dims =
      input.image.width === cert.work.width && input.image.height === cert.work.height
        ? "尺寸相同"
        : `尺寸 ${input.image.width}×${input.image.height}（导出时 ${cert.work.width}×${cert.work.height}）`
    add("file", "warn", `文件字节不同，可能经过转存、压缩或截图（${dims}）；作品归属以指纹核对为准`)
  }

  // 5. 原图
  if (!input.sourceSha256) add("source", "skip", "未提供原图（创作者举证时可提交原图比对 sourceSha256）")
  else if (input.sourceSha256 === cert.work.sourceSha256) add("source", "pass", "提供的原图与证书登记的原图哈希一致")
  else add("source", "fail", "提供的原图与证书登记的原图哈希不同", ["work.sourceSha256"])

  const order: CheckItem["id"][] = ["signature", "trust", "fingerprint", "file", "source", "consistency"]
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const ok = items.every((i) => i.status !== "fail")
  return { ok, items, cert }
}

/** 由一次导出的结果组装证书正文（签名前） */
export function buildCertificateBody(a: {
  payload: BlindPayload
  engines: BlindEngine
  keyMode: "public" | "private"
  creator: { name: string; publicKey: string; keyId: string }
  fileName: string
  sourceSha256: string
  outputSha256: string
  width: number
  height: number
  issuedAt?: string
}): CertificateBody {
  return {
    type: CERT_TYPE,
    payloadHex: payloadToHex(a.payload),
    payload: { version: a.payload.version, creator: a.payload.creator, day: a.payload.day, serial: a.payload.serial },
    creator: { name: a.creator.name, publicKey: a.creator.publicKey, keyId: a.creator.keyId },
    work: {
      fileName: a.fileName,
      sourceSha256: a.sourceSha256,
      outputSha256: a.outputSha256,
      width: a.width,
      height: a.height,
    },
    watermark: { engines: a.engines, keyMode: a.keyMode },
    issuedAt: a.issuedAt ?? new Date().toISOString(),
  }
}

export const STATUS_MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "–" }

/** 纯文本清单（命令行输出） */
export function formatReport(r: CertificateReport): string {
  const lines = r.items.map((i) => {
    const fields = i.fields?.length ? `\n      字段：${i.fields.join(", ")}` : ""
    return `  ${STATUS_MARK[i.status]} ${i.title}\n      ${i.detail}${fields}`
  })
  const head = r.cert
    ? `证书 ${r.cert.payloadHex} · ${r.cert.creator.name} · keyId ${formatKeyId(r.cert.creator.keyId)} · 签发于 ${r.cert.issuedAt}`
    : "证书无法解析"
  const warns = r.items.filter((i) => i.status === "warn").length
  const verdict = !r.ok ? "结论：核验未通过" : warns ? `结论：通过，但有 ${warns} 项需要人工确认` : "结论：全部通过"
  return [head, ...lines, verdict].join("\n")
}

export const SIGNATURE_DISCLAIMER =
  "签名只证明“这把密钥的持有者在 issuedAt 时自行声明了这些内容”，不是权威时间戳，也不是法律意义上的权属认定。"
