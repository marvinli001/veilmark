"use client"

import { useEffect } from "react"
import { create } from "zustand"

import { useStudio, type Asset } from "@/lib/store"
import { decodeImage } from "@/lib/watermark/codec"
import { applyGlance, boxBlur, featherRadius } from "@/lib/watermark/glance/cpu"
import {
  createGlanceRenderer,
  probeWebGL2,
  type GlanceRenderer,
  type WebGLCaps,
} from "@/lib/watermark/glance/shader"
import type { GlanceConfig } from "@/lib/watermark/glance/types"
import { liveMapsKey, type LiveKind, type LiveSupport } from "@/lib/watermark/live"
import { composeVisible, glanceMask, pipelineContext, type WatermarkJob } from "@/lib/watermark/pipeline"
import type { TemplateContext } from "@/lib/watermark/visible/types"
import { liveWorker } from "@/lib/workers/client"

/**
 * 实时预览的主线程部分：
 * - "gl"：WebGL2 画布，原图分辨率，只改 uniform 时每帧直接 render()；
 * - "2d"：Canvas 2D 画布，按显示分辨率重画原图 + 显性图层。
 *
 * 画布与渲染器是模块级单例：WebGL 上下文创建昂贵，而且画布节点在 DOM 里挪位置（切换对比模式）
 * 不会丢失上下文，所以由 Stage 用“插槽”把同一个节点挂到需要的位置。
 */

type Surface = "gl" | "2d"

interface LiveState {
  caps: WebGLCaps | null
  /** 最近一次成功绘制的画布及其所属图片 */
  mode: Surface | null
  assetId: string | null
  /** 这一帧属于哪次拖动（以拖动开始时的结果对象标识），防止把上一次拖动的旧画面当成当前预览 */
  forResult: unknown
  /** 渲染器创建或上传失败时的原因（会让 caps 退化为不支持） */
  hint: string | null
}

// 能力探测放在模块加载时（只在浏览器里做一次），渲染期直接可读，不依赖某个组件的 effect 先跑
export const useLive = create<LiveState>(() => ({
  caps: typeof window === "undefined" ? null : probeWebGL2(),
  mode: null,
  assetId: null,
  forResult: undefined,
  hint: null,
}))

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

let glCanvas: HTMLCanvasElement | null = null
let canvas2d: HTMLCanvasElement | null = null
let renderer: GlanceRenderer | null = null

export function liveCanvas(kind: Surface): HTMLCanvasElement {
  if (kind === "gl") return (glCanvas ??= document.createElement("canvas"))
  return (canvas2d ??= document.createElement("canvas"))
}

/** 渲染器失败时整体退化为“不支持 WebGL2”，让 Studio 恢复防抖 + CPU 路径 */
function degrade(reason: string) {
  useLive.setState({ caps: { webgl2: false, maxTextureSize: 0 }, hint: reason, mode: null })
}

function getRenderer(): GlanceRenderer | null {
  if (renderer) return renderer
  try {
    renderer = createGlanceRenderer(liveCanvas("gl"))
  } catch (e) {
    degrade(errMsg(e))
  }
  return renderer
}

// --- 帧通知：放大镜订阅它来重画，而不是让整个 Stage 每帧重渲染 ---
const frameListeners = new Set<() => void>()
export function onLiveFrame(cb: () => void) {
  frameListeners.add(cb)
  return () => void frameListeners.delete(cb)
}
function frameDone(mode: Surface, assetId: string) {
  const s = useLive.getState()
  const forResult = useStudio.getState().resultBeforeInteraction
  if (s.mode !== mode || s.assetId !== assetId || s.forResult !== forResult) useLive.setState({ mode, assetId, forResult })
  frameListeners.forEach((f) => f())
}

// --- GPU 纹理状态（属于当前这张图） ---
const glState = {
  assetId: "",
  baseKey: "",
  mapsKey: "",
  autoAxis: "blue-yellow" as "blue-yellow" | "red-green",
  ready: false,
  /** 节流：同一时刻最多一个准备请求在途，完成后由帧函数按最新参数决定是否再发 */
  inflight: null as Promise<void> | null,
}

// --- 单帧耗时统计（performance.now，测 render() 提交 + 可选的 GPU 同步） ---
const perf = { measure: false, frames: [] as number[], preps: [] as number[] }

const axisFor = (cfg: GlanceConfig) => (cfg.chroma.axis === "auto" ? glState.autoAxis : cfg.chroma.axis)

function renderGL(r: GlanceRenderer, cfg: GlanceConfig) {
  const t0 = performance.now()
  r.render(cfg, axisFor(cfg))
  if (perf.measure) r.sync()
  perf.frames.push(performance.now() - t0)
  if (perf.frames.length > 600) perf.frames.shift()
}

/** 请求 Worker 准备底图与掩膜；已有请求在途时直接复用（拖动中的中间值被跳过，只追最新值） */
function prepareGL(r: GlanceRenderer, asset: Asset, job: WatermarkJob, tpl: TemplateContext, onDone: () => void) {
  if (glState.inflight) return glState.inflight
  const haveBase = glState.assetId === asset.id ? glState.baseKey : ""
  const t0 = performance.now()
  glState.inflight = liveWorker()
    .prepareLive(asset.id, asset.file, job, tpl, haveBase)
    .then((p) => {
      if (p.base) {
        r.setImage(p.base, p.width, p.height)
        p.base.close()
        glState.baseKey = p.baseKey
      }
      r.setMapsR8(p.mask, p.act)
      glState.assetId = asset.id
      glState.mapsKey = p.mapsKey
      glState.autoAxis = p.autoAxis
      glState.ready = true
      perf.preps.push(performance.now() - t0)
      if (perf.preps.length > 200) perf.preps.shift()
    })
    .catch((e) => degrade(`实时预览失败：${errMsg(e)}`))
    .finally(() => {
      // 完成后重画一帧：帧函数会比对键，参数在此期间又变了就发起下一次准备
      glState.inflight = null
      onDone()
    })
  return glState.inflight
}

// --- 主线程解码缓存（2D 预览用） ---
const sourceCache = new Map<string, ImageBitmap>()
const layerImages = new Map<string, ImageBitmap>()
const decoding = new Set<string>()

function ensureDecoded(key: string, load: () => Promise<ImageBitmap>, into: Map<string, ImageBitmap>, onReady: () => void) {
  if (into.has(key) || decoding.has(key)) return
  decoding.add(key)
  load()
    .then((b) => into.set(key, b))
    .catch(() => {})
    .finally(() => {
      decoding.delete(key)
      onReady()
    })
}

function draw2D(asset: Asset, job: WatermarkJob, tpl: TemplateContext, display: { w: number; h: number }, redraw: () => void) {
  const source = sourceCache.get(asset.id)
  if (!source) {
    // 只保留当前图的解码结果，切图时释放上一张
    for (const [k, b] of sourceCache) {
      if (k === asset.id) continue
      b.close()
      sourceCache.delete(k)
    }
    ensureDecoded(asset.id, () => decodeImage(asset.file), sourceCache, redraw)
    return
  }
  for (const l of job.visible) {
    const src = l.kind === "image" ? l.image?.src : undefined
    if (src) ensureDecoded(src, async () => createImageBitmap(await (await fetch(src)).blob()), layerImages, redraw)
  }
  // 画框尺寸还没量出来（例如页面隐藏时 ResizeObserver 不回调）时，按 1600px 宽兜底
  const target = display.w > 0 ? display.w * (window.devicePixelRatio || 1) : 1600
  const w = Math.max(1, Math.min(asset.width, Math.round(target)))
  const h = Math.max(1, Math.round((w * asset.height) / asset.width))
  const c = liveCanvas("2d")
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const ctx = c.getContext("2d")!
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  // 显性图层的尺寸都相对短边，按显示分辨率画出来的比例与全分辨率一致
  composeVisible(ctx, job, pipelineContext(job, tpl, w, h), { images: layerImages })
  frameDone("2d", asset.id)
}

/**
 * 拖动期间驱动实时预览。support 由 Studio 计算（同一结论也决定是否暂停 CPU 管线）。
 */
export function useLivePreview({
  asset,
  author,
  index,
  interacting,
  support,
  display,
}: {
  asset: Asset | undefined
  author: string
  index: number
  interacting: LiveKind | null
  support: LiveSupport | null
  display: { w: number; h: number }
}) {
  const ok = !!support?.ok
  const assetId = asset?.id
  const filename = asset?.name

  useEffect(() => {
    if (!ok || !interacting || !asset) return
    const ctx: TemplateContext = { author, filename, index, date: new Date() }
    let cancel: (() => void) | null = null
    let disposed = false
    // 每帧最多画一次；页面被隐藏时 rAF 会停摆，改用定时器，保证松手前的最后一帧和状态照常落地
    const schedule = () => {
      if (disposed || cancel) return
      if (document.visibilityState === "hidden") {
        const t = setTimeout(frame, 16)
        cancel = () => clearTimeout(t)
      } else {
        const r = requestAnimationFrame(frame)
        cancel = () => cancelAnimationFrame(r)
      }
    }

    function frame() {
      cancel = null
      if (!asset) return
      const job = useStudio.getState().job
      if (interacting === "visible") return draw2D(asset, job, ctx, display, schedule)
      const r = getRenderer()
      if (!r) return
      if (glState.assetId !== asset.id || liveMapsKey(job, ctx) !== glState.mapsKey) prepareGL(r, asset, job, ctx, schedule)
      // 纹理可能是上一轮参数的（掩膜还在路上），uniform 先照当前值画：振幅等立即跟手
      if (glState.ready && glState.assetId === asset.id) {
        renderGL(r, job.glance)
        frameDone("gl", asset.id)
      }
    }

    schedule()
    const unsub = useStudio.subscribe((s, prev) => {
      if (s.job !== prev.job) schedule()
    })
    return () => {
      disposed = true
      unsub()
      cancel?.()
    }
    // asset 对象随处理状态频繁变化，只按 id 重建；display 在拖动中不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, interacting, assetId, author, filename, index])
}

// ---------------------------------------------------------------------------
// 开发期验收脚本：window.__veilmarkLive.parity() / .bench()
// ---------------------------------------------------------------------------

function percentile(sorted: ArrayLike<number>, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function ensurePrepared(): Promise<{ r: GlanceRenderer; asset: Asset; job: WatermarkJob; tpl: TemplateContext }> {
  const s = useStudio.getState()
  const asset = s.assets.find((a) => a.id === s.activeId)
  if (!asset) throw new Error("先添加一张图片")
  const r = getRenderer()
  if (!r) throw new Error(useLive.getState().hint ?? "WebGL2 不可用")
  const tpl: TemplateContext = {
    author: s.job.author,
    filename: asset.name,
    index: s.assets.indexOf(asset),
    date: new Date(),
  }
  if (glState.assetId !== asset.id || liveMapsKey(s.job, tpl) !== glState.mapsKey) {
    await prepareGL(r, asset, s.job, tpl, () => {})
    if (glState.inflight) await glState.inflight
  }
  return { r, asset, job: s.job, tpl }
}

/**
 * 一致性验收：同一底图、同一组参数下，比较 WebGL readPixels 与 CPU applyGlance 的逐像素差。
 * - CPU 端用 Worker 里的浮点底图/掩膜/JND 图（即导出路径的输入），GPU 端用上传的 R8 纹理；
 * - 另外校验 GPU 读回的底图与 Worker 底图逐字节一致（关掉所有层渲染一次，抖动在取整时被吸收）。
 */
async function parity(override?: (cfg: GlanceConfig) => GlanceConfig) {
  const { r, job } = await ensurePrepared()
  const snap = await liveWorker().liveSnapshot()
  if (!snap) throw new Error("实时预览尚未准备好")
  const cfg = override ? override(structuredClone(job.glance)) : job.glance
  const off: GlanceConfig = {
    ...cfg,
    grating: { ...cfg.grating, enabled: false },
    pantograph: { ...cfg.pantograph, enabled: false },
    tone: { ...cfg.tone, enabled: false },
    chroma: { ...cfg.chroma, enabled: false },
  }
  const W = r.width
  const H = r.height
  r.render(off, axisFor(off))
  const gpuBase = r.readPixels()
  let baseMismatch = 0
  for (let i = 0; i < gpuBase.length; i++) if (gpuBase[i] !== snap.base.data[i]) baseMismatch++
  r.render(cfg, axisFor(cfg))
  const gpu = r.readPixels()

  const t0 = performance.now()
  const axis = cfg.chroma.axis === "auto" ? snap.autoAxis : cfg.chroma.axis
  const cpu = applyGlance(snap.base, snap.soft, cfg, { soft: snap.soft, act: snap.act, axis }).data
  const cpuMs = performance.now() - t0

  const diffs = new Uint8Array(W * H * 3)
  let sum = 0
  let k = 0
  const hist = [0, 0, 0, 0]
  for (let i = 0; i < gpu.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(gpu[i + c] - cpu[i + c])
      diffs[k++] = d
      sum += d
      hist[Math.min(3, d)]++
    }
  diffs.sort()
  const n = diffs.length
  const result = {
    size: `${W}×${H}`,
    mode: cfg.mode,
    layers: {
      grating: cfg.grating.enabled && `${cfg.grating.kind} ${cfg.grating.amplitude}`,
      pantograph: cfg.pantograph.enabled && cfg.pantograph.amplitude,
      tone: cfg.tone.enabled && cfg.tone.amplitude,
      chroma: cfg.chroma.enabled && `${cfg.chroma.amplitude} ${axis}`,
    },
    baseMismatch,
    meanAbs: +(sum / n).toFixed(4),
    p99: percentile(diffs, 0.99),
    p999: percentile(diffs, 0.999),
    max: diffs[n - 1],
    share: { "0": +(hist[0] / n).toFixed(4), "1": +(hist[1] / n).toFixed(4), "2": +(hist[2] / n).toFixed(5), "≥3": +(hist[3] / n).toFixed(6) },
    cpuMs: Math.round(cpuMs),
  }
  r.render(job.glance, axisFor(job.glance)) // 恢复画面
  return result
}

/** 诊断：主线程与 Worker 各自光栅化同一掩膜，统计差异（字体可用性不同会导致字形不同） */
async function maskParity() {
  const { r, job, tpl } = await ensurePrepared()
  const snap = await liveWorker().liveSnapshot()
  if (!snap) throw new Error("实时预览尚未准备好")
  const W = r.width
  const H = r.height
  const main = boxBlur(glanceMask(job, pipelineContext(job, tpl, W, H), W, H), featherRadius(job.glance, W, H))
  let differ = 0
  let sum = 0
  for (let i = 0; i < main.data.length; i++) {
    const d = Math.abs(main.data[i] - snap.soft.data[i])
    sum += d
    if (d > 0.5) differ++
  }
  const probe = (font: string) => {
    const c = new OffscreenCanvas(1, 1).getContext("2d")!
    c.font = `800 40px ${font}`
    return c.measureText("© Veilmark 2026").width
  }
  return {
    pixelsDiffering: differ,
    share: +(differ / main.data.length).toFixed(5),
    meanAbs: +(sum / main.data.length).toFixed(5),
    mainWidths: { stack: probe(job.glance.text.fontFamily), sans: probe("sans-serif") },
  }
}

/** 单帧耗时：连续改振幅渲染 n 帧，每帧 readPixels(1px) 强制等待 GPU 完成后计时 */
async function bench(n = 120) {
  const { r, job } = await ensurePrepared()
  const cfg = structuredClone(job.glance)
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const a = 1 + (i % 20) * 0.5
    cfg.grating.amplitude = a
    cfg.tone.amplitude = a / 4
    cfg.chroma.amplitude = a
    const t0 = performance.now()
    r.render(cfg, axisFor(cfg))
    r.sync()
    times.push(performance.now() - t0)
    await new Promise((res) => requestAnimationFrame(res))
  }
  r.render(job.glance, axisFor(job.glance))
  const sorted = [...times].sort((a, b) => a - b)
  return {
    size: `${r.width}×${r.height}`,
    frames: n,
    medianMs: +percentile(sorted, 0.5).toFixed(2),
    p95Ms: +percentile(sorted, 0.95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
  }
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  Object.assign(window, {
    __veilmarkLive: {
      parity,
      maskParity,
      bench,
      /** 打开后，真实拖动时每帧都会 readPixels(1px) 同步，frames() 得到含 GPU 执行的耗时 */
      set measure(v: boolean) {
        perf.measure = v
        perf.frames.length = 0
        perf.preps.length = 0
      },
      frames: () => [...perf.frames],
      /** 每次 Worker 准备底图/掩膜（含传输与纹理上传）的耗时 */
      preps: () => [...perf.preps],
      /** 模拟不支持 WebGL2 或纹理上限很小，用于验证回退路径 */
      simulateCaps: (caps: WebGLCaps | null) => useLive.setState({ caps: caps ?? probeWebGL2(), hint: null }),
      state: () => ({
        ...glState,
        inflight: !!glState.inflight,
        live: useLive.getState(),
        interacting: useStudio.getState().interacting,
      }),
    },
  })
}
