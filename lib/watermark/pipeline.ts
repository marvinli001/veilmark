import { embedClassic, DEFAULT_KEY } from "./blind/classic"
import { creatorIdFromText, dayFromDate, payloadToHex, type BlindPayload } from "./blind/payload"
import type { OrtModule, TrustMarkSessions } from "./blind/trustmark"
import { psnr, type RGBAImage } from "./core/image"
import { applyGlance } from "./glance/cpu"
import { glanceMaskStyle, glancePreset, type GlanceConfig } from "./glance/types"
import { renderTextMask, renderVisibleLayer, type Ctx2D, type RenderAssets } from "./visible/render"
import { defaultLayer, type TemplateContext, type VisibleLayer } from "./visible/types"

/**
 * 统一处理管线。顺序是刻意的：
 *   1. 显性水印（Canvas 2D 合成）
 *   2. 伪隐性水印（逐像素，需在显性层之后，否则显性层会覆盖其高频结构）
 *   3. 盲水印（最后嵌入：前面任何像素改动都会破坏它的闭环余量）
 *   4. 编码导出
 */

export type BlindEngine = "cdp" | "trustmark" | "dual"

export interface BlindConfig {
  enabled: boolean
  engine: BlindEngine
  /** 公开密钥：任何人都能用本工具验证；私有密钥：只有持有者能检出 */
  key: string
  strength: number
  creator: string
  /**
   * 用签名身份派生创作者 ID（SHA-256(公钥) 前 24 bit），让指纹与密钥绑定。
   * 开启后由主线程在提交处理前把 creator 换成派生出的数字 ID（见 lib/store.ts 的 processingJob）
   */
  creatorFromIdentity: boolean
  /** 序号来源：原图哈希 / 批量序号 / 手动 */
  serialMode: "hash" | "index" | "manual"
  serial: number
}

export type ExportFormat = "png" | "webp-lossless" | "webp" | "jpeg"

export interface ExportConfig {
  format: ExportFormat
  quality: number
  /** 文件名模板，支持与显性水印相同的变量 */
  filename: string
}

export interface WatermarkJob {
  author: string
  visible: VisibleLayer[]
  glance: GlanceConfig
  blind: BlindConfig
  export: ExportConfig
}

export const defaultJob = (): WatermarkJob => ({
  author: "",
  visible: [defaultLayer("layer-1")],
  glance: { ...glancePreset("daily"), enabled: false },
  blind: {
    enabled: true,
    engine: "cdp",
    key: DEFAULT_KEY,
    strength: 5,
    creator: "",
    creatorFromIdentity: false,
    serialMode: "hash",
    serial: 0,
  },
  export: { format: "png", quality: 0.95, filename: "{filename}_wm" },
})

export interface PipelineDeps {
  assets?: RenderAssets
  /** 可选的 TrustMark 运行时（懒加载后注入） */
  trustmark?: { ort: OrtModule; sessions: TrustMarkSessions }
  /** 原文件字节，用于 serialMode=hash */
  sourceBytes?: ArrayBuffer
}

export interface PipelineReport {
  psnr: number
  payload: BlindPayload | null
  payloadHex: string | null
  engines: BlindEngine | null
  warnings: string[]
  timings: Record<string, number>
}

function ctx2d(c: OffscreenCanvas) {
  const ctx = c.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("OffscreenCanvas 不可用")
  return ctx
}

async function buildPayload(cfg: BlindConfig, tpl: TemplateContext, deps: PipelineDeps): Promise<BlindPayload> {
  let serial = cfg.serial & 0x3fff
  if (cfg.serialMode === "index") serial = (tpl.index ?? 0) & 0x3fff
  if (cfg.serialMode === "hash" && deps.sourceBytes) {
    const { serialFromBytes } = await import("./blind/payload")
    serial = await serialFromBytes(deps.sourceBytes)
  }
  return {
    version: 1,
    creator: creatorIdFromText(cfg.creator || tpl.author || "anonymous"),
    day: dayFromDate(tpl.date ?? new Date()),
    serial,
  }
}

export function lossyExportWarnings(job: WatermarkJob): string[] {
  const w: string[] = []
  const lossy = job.export.format === "jpeg" || job.export.format === "webp"
  const hf = job.glance.enabled && (job.glance.grating.enabled || job.glance.pantograph.enabled)
  if (lossy && hf) w.push("伪隐性水印的高频层（相位光栅/防复印底纹）会被有损压缩抹除，请改用 PNG 或无损 WebP")
  return w
}

/** 模板变量上下文：署名缺省取 job.author，宽高取实际画布 */
export function pipelineContext(job: WatermarkJob, tpl: TemplateContext, W: number, H: number): TemplateContext {
  return { ...tpl, author: tpl.author ?? job.author, width: W, height: H }
}

/**
 * 管线第 1 步：把显性图层合成到画布上（画布上已有原图）。
 * 实时预览的底图（显性已合成、伪隐性未叠加）也调用这里，保证预览与导出的底图一致。
 */
export function composeVisible(ctx: Ctx2D, job: WatermarkJob, context: TemplateContext, assets?: RenderAssets) {
  for (const layer of job.visible) renderVisibleLayer(ctx, layer, context, assets)
}

/** 伪隐性水印的信息掩膜（管线第 2 步的输入），预览与导出共用 */
export function glanceMask(job: WatermarkJob, context: TemplateContext, W: number, H: number) {
  return renderTextMask(W, H, glanceMaskStyle(job.glance), job.glance.layout, context)
}

export async function runPipeline(
  source: ImageBitmap | RGBAImage,
  job: WatermarkJob,
  tpl: TemplateContext,
  deps: PipelineDeps = {}
): Promise<{ image: RGBAImage; report: PipelineReport }> {
  const t: Record<string, number> = {}
  let mark = performance.now()
  const lap = (k: string) => {
    const now = performance.now()
    t[k] = Math.round(now - mark)
    mark = now
  }

  const W = source.width
  const H = source.height
  const canvas = new OffscreenCanvas(W, H)
  const ctx = ctx2d(canvas)
  if ("close" in source) ctx.drawImage(source, 0, 0)
  else ctx.putImageData(new ImageData(new Uint8ClampedArray(source.data), W, H), 0, 0)
  const original = ctx.getImageData(0, 0, W, H)
  const context = pipelineContext(job, tpl, W, H)

  composeVisible(ctx, job, context, deps.assets)
  lap("visible")

  let img: RGBAImage = ctx.getImageData(0, 0, W, H)
  if (job.glance.enabled) {
    const mask = glanceMask(job, context, W, H)
    img = applyGlance(img, mask, job.glance)
    lap("glance")
  }

  let payload: BlindPayload | null = null
  let payloadHex: string | null = null
  if (job.blind.enabled) {
    payload = await buildPayload(job.blind, context, deps)
    payloadHex = payloadToHex(payload)
    const { engine } = job.blind
    if (engine === "trustmark" || engine === "dual") {
      if (!deps.trustmark) throw new Error("TrustMark 模型尚未加载")
      const { embedTrustMark } = await import("./blind/trustmark")
      img = await embedTrustMark(deps.trustmark.ort, deps.trustmark.sessions, img, payload)
      lap("trustmark")
    }
    if (engine === "cdp" || engine === "dual") {
      img = embedClassic(img, payload, { key: job.blind.key || DEFAULT_KEY, strength: job.blind.strength })
      lap("cdp")
    }
  }

  return {
    image: img,
    report: {
      psnr: psnr(original, img),
      payload,
      payloadHex,
      engines: job.blind.enabled ? job.blind.engine : null,
      warnings: lossyExportWarnings(job),
      timings: t,
    },
  }
}
