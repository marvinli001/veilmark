import * as Comlink from "comlink"

import { collectDocumentFonts } from "./fonts"
import type { WatermarkWorkerApi } from "./watermark.worker"

/** 单例预览 Worker + 批处理 Worker 池 */

type Remote = Comlink.Remote<WatermarkWorkerApi>

function spawn(): { remote: Remote; worker: Worker } {
  const worker = new Worker(new URL("./watermark.worker.ts", import.meta.url), { type: "module" })
  const remote = Comlink.wrap<WatermarkWorkerApi>(worker)
  // Worker 看不到页面的 @font-face 字体，先注册；Worker 内部会等它完成再画字
  remote.registerFonts(collectDocumentFonts()).catch(() => {})
  return { remote, worker }
}

let preview: Remote | null = null
export function previewWorker(): Remote {
  preview ??= spawn().remote
  return preview
}

/** 实时预览专用 Worker：与预览 Worker 分开，拖动时准备底图不会排在一次 1 s 的全分辨率处理后面 */
let live: Remote | null = null
export function liveWorker(): Remote {
  live ??= spawn().remote
  return live
}

/**
 * 并发执行批量任务。池大小 = min(4, 核数 − 1)：盲水印闭环是内存带宽型负载，
 * 再多的 Worker 只会互相抢带宽。
 */
export async function runPool<T, R>(
  items: T[],
  task: (worker: Remote, item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
  setup?: (worker: Remote) => Promise<unknown>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, items.length))
  const pool = Array.from({ length: size }, spawn)
  const workers = pool.map((p) => p.remote)
  if (setup) await Promise.all(workers.map(setup))
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length)
  let next = 0
  let done = 0
  await Promise.all(
    workers.map(async (w) => {
      while (next < items.length) {
        const i = next++
        try {
          results[i] = { ok: true, value: await task(w, items[i], i) }
        } catch (e) {
          results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        onProgress?.(++done, items.length)
      }
    })
  )
  pool.forEach((p) => {
    p.remote[Comlink.releaseProxy]()
    p.worker.terminate()
  })
  return results
}
