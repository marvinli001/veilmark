/// <reference lib="webworker" />
import * as Comlink from "comlink"

import type { OrtModule, TrustMarkSessions } from "../watermark/blind/trustmark"
import { bitmapToRGBA, decodeImage, encodeImage } from "../watermark/codec"
import { amplifiedDiff, simulateReveal, type RevealKind } from "../watermark/glance/simulate"
import { runPipeline, type PipelineReport, type WatermarkJob } from "../watermark/pipeline"
import type { TemplateContext } from "../watermark/visible/types"
import { verifyImage } from "../watermark/verify"

/**
 * 所有重计算都在 Worker 里：解码、合成、盲水印闭环、编码。
 * 主线程只负责 UI，批量处理时按 hardwareConcurrency 起多个 Worker 组成池。
 */

let trustmark: { ort: OrtModule; sessions: TrustMarkSessions } | undefined
const imageAssets = new Map<string, ImageBitmap>()

async function ensureTrustMark(baseUrl: string, withEncoder: boolean) {
  if (trustmark && (!withEncoder || trustmark.sessions.encoder)) return
  // onnxruntime-web 的 wasm 由打包器作为独立静态资源产出，只有用到 TrustMark 时才会下载；
  // 有 WebGPU 时优先 GPU，否则回退 WASM
  const ort = await import("onnxruntime-web")
  const { loadTrustMark } = await import("../watermark/blind/trustmark")
  const sessions = await loadTrustMark(ort, baseUrl, { withEncoder })
  trustmark = { ort, sessions }
}

/**
 * 图片水印位图按 src（dataURL）缓存在 Worker 里。模板切换、刷新页面、批处理池里的新 Worker
 * 都可能拿到一个还没注册过的 src，这里按需解码，调用方不必事先逐个 registerImageAsset。
 */
async function ensureImageAssets(job: WatermarkJob) {
  for (const l of job.visible) {
    const src = l.kind === "image" ? l.image?.src : undefined
    if (!src || imageAssets.has(src)) continue
    try {
      imageAssets.set(src, await createImageBitmap(await (await fetch(src)).blob()))
    } catch {
      // 失效的图片来源（例如被撤销的 blob URL）只影响这一个图层，渲染时会被跳过
    }
  }
}

export interface ProcessResult {
  blob: Blob
  width: number
  height: number
  report: PipelineReport
}

const api = {
  async registerImageAsset(src: string, blob: Blob) {
    imageAssets.set(src, await createImageBitmap(blob))
  },

  async loadTrustMark(baseUrl: string, withEncoder = true) {
    await ensureTrustMark(baseUrl, withEncoder)
    return true
  },

  async process(file: Blob, job: WatermarkJob, tpl: TemplateContext): Promise<ProcessResult> {
    await ensureImageAssets(job)
    const bitmap = await decodeImage(file)
    try {
      const { image, report } = await runPipeline(bitmap, job, tpl, {
        assets: { images: imageAssets },
        trustmark,
        sourceBytes: job.blind.serialMode === "hash" ? await file.arrayBuffer() : undefined,
      })
      const blob = await encodeImage(image, job.export)
      return { blob, width: image.width, height: image.height, report }
    } finally {
      bitmap.close()
    }
  },

  /** 盗用模拟：对原图与处理后图同时施加同一变换，返回 PNG 供对比 */
  async reveal(original: Blob, processed: Blob, kind: RevealKind | "diff") {
    const [a, b] = await Promise.all([decodeImage(original), decodeImage(processed)])
    const A = bitmapToRGBA(a)
    const B = bitmapToRGBA(b)
    a.close()
    b.close()
    const png = { format: "png" as const, quality: 1, filename: "" }
    if (kind === "diff") return { after: await encodeImage(amplifiedDiff(A, B), png) }
    const [before, after] = await Promise.all([
      encodeImage(simulateReveal(A, kind), png),
      encodeImage(simulateReveal(B, kind), png),
    ])
    return { before, after }
  },

  async verify(file: Blob, keys: string[], trustmarkBaseUrl?: string) {
    if (trustmarkBaseUrl) await ensureTrustMark(trustmarkBaseUrl, false)
    const bitmap = await decodeImage(file)
    const img = bitmapToRGBA(bitmap)
    bitmap.close()
    return verifyImage(img, { keys, trustmark: trustmarkBaseUrl ? trustmark : undefined })
  },
}

export type WatermarkWorkerApi = typeof api
Comlink.expose(api)
