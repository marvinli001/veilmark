import type { Plane, RGBAImage } from "./core/image"
import { activityMap, boxBlur, featherRadius, resolveChromaAxis } from "./glance/cpu"
import { ACT_R8_SCALE, planeToR8, type R8Plane, type WebGLCaps } from "./glance/shader"
import { composeVisible, glanceMask, pipelineContext, type WatermarkJob } from "./pipeline"
import type { RenderAssets } from "./visible/render"
import type { TemplateContext } from "./visible/types"

/**
 * 拖动滑杆时的实时预览。
 *
 * 全分辨率 CPU 管线一次 0.3–1.5 s，拖动时跟不上手。实时预览把参数分成三类：
 * - 只影响 shader uniform（各层振幅、光栅类型/周期/角度、底纹周期、暗部偏置、色度轴）：
 *   GPU 直接重绘，每帧 < 16 ms；
 * - 影响底图或掩膜（显性图层、文字、字号、旋转、密度、羽化、纹理自适应）：
 *   在专用 Worker 里重算“显性已合成、伪隐性未叠加”的底图与 R8 掩膜/JND 图，按键分项缓存并节流；
 * - 显性图层滑杆：主线程 Canvas 2D 按显示分辨率直接重画。
 * 松手后仍跑一次完整 CPU 管线，用确定性的结果替换预览。
 */

export type LiveKind = "glance" | "visible"

/** 底图只取决于显性图层与模板变量 */
export function liveBaseKey(job: WatermarkJob, tpl: TemplateContext) {
  return JSON.stringify([job.visible, tpl.author ?? job.author, tpl.filename, tpl.index])
}
/** 羽化前的掩膜：文字与排版（文字里可能有 {author} 等变量） */
export const liveMaskKey = (job: WatermarkJob, tpl: TemplateContext) =>
  JSON.stringify([job.glance.text, job.glance.layout, tpl.author ?? job.author, tpl.filename, tpl.index])
export const liveSoftKey = (job: WatermarkJob, tpl: TemplateContext) => `${liveMaskKey(job, tpl)}|${job.glance.feather}`
export const liveActKey = (job: WatermarkJob) => String(job.glance.adaptive)
/** 以上全部：主线程据此判断手上的纹理是否仍然有效 */
export const liveMapsKey = (job: WatermarkJob, tpl: TemplateContext) =>
  `${liveBaseKey(job, tpl)}#${liveSoftKey(job, tpl)}#${liveActKey(job)}`

/**
 * 实时预览要在专用 Worker 里常驻原图、底图与浮点掩膜（约 20 B/像素），外加一份 GPU 纹理；
 * 超过 5000 万像素时内存开销过大，宁可退回防抖 + CPU
 */
export const MAX_LIVE_PIXELS = 50_000_000

export interface LiveSupport {
  ok: boolean
  /** 不可用且值得告诉用户时的原因（例如不支持 WebGL2） */
  reason?: string
}

/**
 * 当前交互能否由实时预览接管。接管时 CPU 管线在拖动期间暂停；不能接管时维持原来的“防抖 + CPU”。
 */
export function liveSupport(
  kind: LiveKind,
  s: { caps: WebGLCaps | null; width: number; height: number; job: WatermarkJob; reveal: string; pinned: boolean }
): LiveSupport {
  // 盗用模拟与“此图使用别的模板”两种情况下，面板改动与画布内容对不上，不做实时预览
  if (s.reveal !== "none" || s.pinned) return { ok: false }
  if (kind === "visible") return { ok: true }
  if (!s.job.glance.enabled) return { ok: false }
  if (!s.caps) return { ok: false }
  if (!s.caps.webgl2) return { ok: false, reason: "浏览器不支持 WebGL2" }
  if (Math.max(s.width, s.height) > s.caps.maxTextureSize)
    return { ok: false, reason: `图片超过 GPU 纹理上限 ${s.caps.maxTextureSize}px` }
  if (s.width * s.height > MAX_LIVE_PIXELS) return { ok: false, reason: "图片超过 5000 万像素" }
  return { ok: true }
}

export interface LivePrepared {
  baseKey: string
  mapsKey: string
  width: number
  height: number
  /** 底图与调用方手上的版本相同时为 null，省掉一次位图复制与纹理上传 */
  base: ImageBitmap | null
  mask: R8Plane
  act: R8Plane
  /** chroma.axis = "auto" 时按底图解析出的轴 */
  autoAxis: "blue-yellow" | "red-green"
}

/**
 * Worker 侧的分项缓存：拖“羽化”只重做模糊，拖“纹理自适应”只重做 JND 图，
 * 拖“字号/旋转/密度”才重画掩膜，显性图层变了才重合成底图。
 */
export class LivePreparer {
  private canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private base: RGBAImage | null = null
  private keys = { base: "", mask: "", soft: "", act: "" }
  private mask: Plane | null = null
  private soft: Plane | null = null
  private act: Plane | null = null
  private autoAxis: "blue-yellow" | "red-green" = "blue-yellow"

  constructor(private source: ImageBitmap) {
    this.canvas = new OffscreenCanvas(source.width, source.height)
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!
  }

  get width() {
    return this.source.width
  }
  get height() {
    return this.source.height
  }

  async prepare(job: WatermarkJob, tpl: TemplateContext, assets: RenderAssets, haveBaseKey: string): Promise<LivePrepared> {
    const W = this.width
    const H = this.height
    const context = pipelineContext(job, tpl, W, H)
    const baseKey = liveBaseKey(job, tpl)
    if (baseKey !== this.keys.base || !this.base) {
      this.ctx.clearRect(0, 0, W, H)
      this.ctx.drawImage(this.source, 0, 0)
      composeVisible(this.ctx, job, context, assets)
      this.base = this.ctx.getImageData(0, 0, W, H)
      this.autoAxis = resolveChromaAxis(this.base, "auto")
      this.keys = { base: baseKey, mask: this.keys.mask, soft: "", act: "" }
    }
    const maskKey = liveMaskKey(job, tpl)
    if (maskKey !== this.keys.mask || !this.mask) {
      this.mask = glanceMask(job, context, W, H)
      this.keys.mask = maskKey
      this.keys.soft = ""
    }
    const softKey = liveSoftKey(job, tpl)
    if (softKey !== this.keys.soft || !this.soft) {
      this.soft = boxBlur(this.mask, featherRadius(job.glance, W, H))
      this.keys.soft = softKey
    }
    const actKey = liveActKey(job)
    if (actKey !== this.keys.act || !this.act) {
      this.act = activityMap(this.base, job.glance.adaptive)
      this.keys.act = actKey
    }
    return {
      baseKey,
      mapsKey: liveMapsKey(job, tpl),
      width: W,
      height: H,
      base: haveBaseKey === baseKey ? null : await createImageBitmap(this.canvas),
      mask: planeToR8(this.soft),
      act: planeToR8(this.act, ACT_R8_SCALE),
      autoAxis: this.autoAxis,
    }
  }

  /** 当前缓存的浮点底图与掩膜（验收脚本用它跑 CPU 参考实现，隔离出 shader 与 CPU 的公式差异） */
  snapshot() {
    if (!this.base || !this.soft || !this.act) return null
    return { base: this.base, soft: this.soft, act: this.act, autoAxis: this.autoAxis }
  }

  dispose() {
    this.source.close()
  }
}
