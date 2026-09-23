import { DEFAULT_KEY, extractClassic } from "./blind/classic"
import { payloadToHex, type BlindPayload } from "./blind/payload"
import type { OrtModule, TrustMarkSessions } from "./blind/trustmark"
import type { RGBAImage } from "./core/image"

export interface VerifyHit {
  engine: "cdp" | "trustmark"
  key?: string
  found: boolean
  payload: BlindPayload | null
  payloadHex: string | null
  /** 统一到 0–1 的置信度，便于 UI 展示 */
  confidence: number
  detail: string
}

/**
 * 抽检入口：依次尝试所有已知密钥的 CDP 引擎，以及（若已加载）TrustMark。
 * CDP 的得分阈值 2.5 远高于无水印图的 ~0.8，叠加 CRC-16 后误报率可忽略。
 */
export async function verifyImage(
  img: RGBAImage,
  opts: { keys?: string[]; trustmark?: { ort: OrtModule; sessions: TrustMarkSessions } } = {}
): Promise<VerifyHit[]> {
  const keys = Array.from(new Set([DEFAULT_KEY, ...(opts.keys ?? []).filter(Boolean)]))
  const hits: VerifyHit[] = []
  for (const key of keys) {
    const r = extractClassic(img, { key })
    hits.push({
      engine: "cdp",
      key,
      found: r.found,
      payload: r.payload,
      payloadHex: r.payload ? payloadToHex(r.payload) : null,
      confidence: Math.min(1, Math.max(0, (r.score - 0.8) / 6)),
      detail: `得分 ${r.score.toFixed(2)} · 规范尺度 ${r.canonical}${r.trimmed ? " · 已裁边" : ""} · 原始误码 ${(r.rawBitErrorRate * 100).toFixed(1)}%`,
    })
    if (r.found) break
  }
  if (opts.trustmark) {
    const { decodeTrustMark } = await import("./blind/trustmark")
    const r = await decodeTrustMark(opts.trustmark.ort, opts.trustmark.sessions, img)
    hits.push({
      engine: "trustmark",
      found: r.found,
      payload: r.payload,
      payloadHex: r.payload ? payloadToHex(r.payload) : null,
      confidence: Math.min(1, r.confidence / 10),
      detail: `置信度 ${r.confidence.toFixed(2)}${r.flippedBits ? ` · 纠正 ${r.flippedBits} bit` : ""}`,
    })
  }
  return hits
}
