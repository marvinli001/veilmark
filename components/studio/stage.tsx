"use client"

import { Badge } from "@appica/ui-react/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@appica/ui-react/select"
import { Toggle } from "@appica/ui-react/toggle"
import { FlaskConical, ImagePlus, Loader2, ScanSearch, Zap } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { useStudio, type Asset } from "@/lib/store"
import { cn } from "@/lib/utils"
import { REVEAL_LABELS, type RevealKind } from "@/lib/watermark/glance/simulate"
import type { LiveSupport } from "@/lib/watermark/live"
import { previewWorker } from "@/lib/workers/client"

import { pickImages } from "./asset-strip"
import { Segmented } from "./controls"
import { liveCanvas, onLiveFrame, useLive, useLivePreview } from "./live-preview"

type Surface = "gl" | "2d"

/**
 * 把实时预览画布（模块级单例）挂到这里。用 display:contents 的宿主，画布本身带上 className/样式，
 * 在布局里的表现与原来的 <img> 一致（canvas 同样是替换元素，object-fit 生效）。
 */
function CanvasSlot({ kind, className, clipPath }: { kind: Surface; className: string; clipPath?: string }) {
  const mount = useCallback(
    (host: HTMLSpanElement | null) => {
      if (!host) return
      const c = liveCanvas(kind)
      c.className = className
      c.style.clipPath = clipPath ?? ""
      c.setAttribute("aria-label", "处理后（实时预览）")
      if (c.parentElement !== host) host.replaceChildren(c)
    },
    [kind, className, clipPath]
  )
  return <span ref={mount} className="contents" />
}

const REVEAL_ITEMS = [
  { value: "none", label: "不模拟盗用" },
  { value: "diff", label: "差异 ×12 放大" },
  ...Object.entries(REVEAL_LABELS).map(([value, label]) => ({ value, label })),
]

/** 放大镜：最近邻采样 1:1 像素，伪隐性水印的高频结构只有这样才看得清。拖动期间改为从实时预览画布取像素 */
function Loupe({
  src,
  altSrc,
  live,
  pos,
  zoom,
}: {
  src: string
  altSrc: string
  live: Surface | null
  pos: Pos | null
  zoom: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const imgs = useRef<{ a?: HTMLImageElement; b?: HTMLImageElement }>({})
  const [alt, setAlt] = useState(false)

  useEffect(() => {
    const a = new Image()
    a.src = src
    const b = new Image()
    b.src = altSrc
    imgs.current = { a, b }
  }, [src, altSrc])

  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === "Alt" && setAlt(true)
    const up = (e: KeyboardEvent) => e.key === "Alt" && setAlt(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [])

  useEffect(() => {
    const draw = () => {
      const c = canvas.current
      if (!c || !pos) return
      const source: CanvasImageSource | undefined = alt ? imgs.current.b : live ? liveCanvas(live) : imgs.current.a
      if (!source || (source instanceof HTMLImageElement && !source.complete)) return
      const sw = source instanceof HTMLImageElement ? source.naturalWidth : (source as HTMLCanvasElement).width
      const sh = source instanceof HTMLImageElement ? source.naturalHeight : (source as HTMLCanvasElement).height
      const ctx = c.getContext("2d")!
      const S = c.width
      const span = S / zoom
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, S, S)
      ctx.drawImage(source, pos.nx * sw - span / 2, pos.ny * sh - span / 2, span, span, 0, 0, S, S)
    }
    draw()
    // 实时预览每画一帧，放大镜跟着重画
    return live && !alt ? onLiveFrame(draw) : undefined
  }, [pos, zoom, alt, live])

  if (!pos) return null
  // 触屏时镜头放在手指上方，不被手指挡住
  const lift = pos.touch ? 120 : 0
  return (
    <div
      className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-background shadow-xl"
      style={{ left: pos.x - 96, top: Math.max(-40, pos.y - 96 - lift), width: 192, height: 192 }}
    >
      <canvas ref={canvas} width={384} height={384} className="size-full" />
      <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background-inverse/70 px-2 py-0.5 text-[10px] whitespace-nowrap text-foreground-inverse">
        {alt ? "原图" : "处理后"} · {zoom}×<span className="hidden can-hover:inline"> · ⌥ 切换</span>
      </span>
    </div>
  )
}

type Pos = { x: number; y: number; nx: number; ny: number; touch: boolean }

/** 按 contain 规则把宽高比为 aspect 的画面放进 w×h 的格子 */
function fit(aspect: number, w: number, h: number) {
  const fw = Math.max(0, Math.min(w, h * aspect))
  return { w: fw, h: fw / aspect }
}

/**
 * 在容器内按 contain 规则计算画框尺寸（div 没有固有尺寸，纯 CSS 的 aspect-ratio 无法同时受宽高约束）。
 * 同时返回容器尺寸，并排对比据此决定左右还是上下排（手机竖屏上下排更大）。
 */
function useFitSize(aspect: number) {
  // 用 state 保存元素（回调 ref），元素挂载/替换时自动重新观察
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0, cw: 0, ch: 0 })
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ ...fit(aspect, width, height), cw: width, ch: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, aspect])
  return [setEl, size] as const
}

export function Stage({
  asset,
  busy,
  author,
  index,
  support,
}: {
  asset: Asset | undefined
  busy: boolean
  /** 当前图的署名与序号（模板变量，与 CPU 管线一致） */
  author: string
  index: number
  /** 当前拖动能否由实时预览接管（Studio 计算，同一结论决定是否暂停 CPU） */
  support: LiveSupport | null
}) {
  const { compare, setCompare, reveal, setReveal, setAssetTemplate } = useStudio()
  const interacting = useStudio((s) => s.interacting)
  const resultBefore = useStudio((s) => s.resultBeforeInteraction)
  const live = useLive()
  const pinned = useStudio((s) =>
    asset?.templateId && asset.templateId !== s.activeTemplateId ? s.templates.find((t) => t.id === asset.templateId) : undefined
  )
  const [split, setSplit] = useState(50)
  const [loupe, setLoupe] = useState(false)
  const [zoom, setZoom] = useState(4)
  const [pos, setPos] = useState<Pos | null>(null)
  const [revealUrls, setRevealUrls] = useState<{ before?: string; after: string } | null>(null)
  const [revealBusy, setRevealBusy] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [fitRef, fitSize] = useFitSize(asset ? asset.width / asset.height : 1)
  useLivePreview({ asset, author, index, interacting, support, display: fitSize })

  // 盗用模拟：原图与处理后图同时经过同一变换
  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    async function run() {
      if (!asset?.result || reveal === "none") return setRevealUrls(null)
      setRevealBusy(true)
      try {
        const r = await previewWorker().reveal(asset.file, asset.result.blob, reveal as RevealKind | "diff")
        if (cancelled) return
        const before = "before" in r && r.before ? URL.createObjectURL(r.before) : undefined
        const after = URL.createObjectURL(r.after)
        urls.push(...[before, after].filter(Boolean) as string[])
        setRevealUrls({ before, after })
      } finally {
        if (!cancelled) setRevealBusy(false)
      }
    }
    run()
    return () => {
      cancelled = true
      urls.forEach(URL.revokeObjectURL)
    }
  }, [asset?.result, asset?.file, reveal])

  /** 指针在画框内的位置；滑动对比时任意处按下/拖动都能移动分割线，放大镜在触屏上按住拖动查看 */
  const locate = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect()
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    return { x: e.clientX - r.left, y: e.clientY - r.top, nx, ny, touch: e.pointerType !== "mouse" }
  }
  const onDown = (e: React.PointerEvent) => {
    if (!frame.current) return
    const p = locate(e)
    try {
      // 拖出画框也继续跟手；指针已失效时会抛错，忽略即可
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {}
    if (loupe) return setPos(p)
    if (compare === "slider") {
      dragging.current = true
      setSplit(p.nx * 100)
    }
  }
  const onMove = (e: React.PointerEvent) => {
    if (!frame.current) return
    const p = locate(e)
    if (dragging.current) setSplit(p.nx * 100)
    // 鼠标悬停即显示放大镜；触屏只在按住时显示
    if (loupe && (!p.touch || e.buttons)) setPos(p)
  }
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false
    if (e.pointerType !== "mouse") setPos(null)
  }

  if (!asset) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-4">
        <button
          onClick={pickImages}
          className="flex size-full max-h-96 max-w-xl flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-strong px-6 text-center outline-ring-primary transition-colors hover:border-border-emphasis hover:bg-background"
        >
          <span className="grid size-12 place-items-center rounded-full bg-background-muted text-foreground-strong">
            <ImagePlus className="size-5" />
          </span>
          <span className="text-base font-medium text-foreground-intense">选择图片开始</span>
          <span className="max-w-xs text-sm leading-relaxed text-foreground-muted">
            PNG / JPG / WebP，可多选<span className="hidden can-hover:inline">，也可以拖进来或 ⌘V 粘贴</span>。全部在本机处理，图片不上传。
          </span>
        </button>
      </div>
    )
  }

  const original = revealUrls?.before ?? asset.url
  const processed = revealUrls?.after ?? asset.result?.url ?? asset.url
  const report = asset.result?.report

  // 实时预览画布的显示条件：画的是这张图、属于这一次拖动；
  // 拖动中画布类型要与拖动类别对应，松手后一直显示到全分辨率新结果替换掉旧结果为止
  const stale = (asset.result ?? null) === resultBefore
  const liveSurface: Surface | null =
    live.mode && live.assetId === asset.id && live.forResult === resultBefore && stale
      ? interacting
        ? support?.ok && live.mode === (interacting === "glance" ? "gl" : "2d")
          ? live.mode
          : null
        : live.mode
      : null
  const liveUnavailable = interacting && support && !support.ok && support.reason ? support.reason : null

  const processedNode = (className: string, clipPath?: string) =>
    liveSurface ? (
      <CanvasSlot kind={liveSurface} className={className} clipPath={clipPath} />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={processed} alt="处理后" className={className} style={clipPath ? { clipPath } : undefined} draggable={false} />
    )

  // 并排对比：左右排和上下排取画面更大的一种（手机竖屏通常是上下排）
  const aspect = asset.width / asset.height
  const CAPTION = 24
  const across = fit(aspect, (fitSize.cw - 16) / 2, fitSize.ch - CAPTION)
  const stacked = fit(aspect, fitSize.cw, (fitSize.ch - 16) / 2 - CAPTION)
  const sideVertical = stacked.w > across.w
  const pane = sideVertical ? stacked : across

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto px-3 pt-2.5 md:px-4">
        <Segmented
          size="sm"
          className="w-auto shrink-0"
          value={compare}
          onChange={setCompare}
          options={[
            { value: "slider", label: "对比" },
            { value: "side", label: "并排" },
            { value: "result", label: "仅结果" },
          ]}
        />
        <Select size="sm" value={reveal} onValueChange={(v) => setReveal((v ?? "none") as typeof reveal)} items={REVEAL_ITEMS}>
          <SelectTrigger
            aria-label="模拟盗用"
            className={cn("w-auto max-w-44 shrink-0 gap-1.5 text-xs", reveal !== "none" && "border-warning-emphasis bg-warning-subtle")}
          >
            <FlaskConical className="size-3.5 shrink-0 text-foreground-muted" />
            <SelectValue>{(v: string) => (v === "none" ? "模拟盗用" : REVEAL_ITEMS.find((i) => i.value === v)?.label)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {REVEAL_ITEMS.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Toggle
          pressed={loupe}
          onPressedChange={(v) => {
            setLoupe(v)
            setPos(null)
          }}
          aria-label="放大镜"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-foreground-muted hover:bg-background-muted data-pressed:bg-background-muted data-pressed:text-foreground-intense"
        >
          <ScanSearch className="size-4" /> <span className="hidden md:inline">放大镜</span>
        </Toggle>
        {loupe && (
          <Segmented
            size="sm"
            className="w-auto shrink-0"
            value={String(zoom)}
            onChange={(v) => setZoom(Number(v))}
            options={["2", "4", "8"].map((z) => ({ value: z, label: `${z}×` }))}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-foreground-muted">
          {liveSurface && (
            <Badge variant="info" size="sm" title="拖动期间的近似预览，松手后替换为全分辨率计算结果">
              <Zap className="size-3" />
              <span className="hidden lg:inline">{liveSurface === "gl" ? "GPU 实时预览" : "实时预览 · 显示分辨率"}</span>
            </Badge>
          )}
          {liveUnavailable && (
            <Badge variant="soft" size="sm" className="hidden lg:inline-flex" title="拖动时改为防抖后 CPU 全分辨率计算">
              实时预览不可用：{liveUnavailable}
            </Badge>
          )}
          {(busy || revealBusy) && <Loader2 className="size-3.5 animate-spin" />}
          {report && (
            <span className="hidden gap-2 xl:flex">
              <Badge variant="soft" size="sm" className="tabular-nums" title="峰值信噪比：越高越接近原图">
                PSNR {Number.isFinite(report.psnr) ? report.psnr.toFixed(1) : "∞"} dB
              </Badge>
              {report.payloadHex && (
                <Badge variant="soft" size="sm" className="font-mono" title="盲水印指纹">
                  ID {report.payloadHex}
                </Badge>
              )}
            </span>
          )}
        </div>
      </div>

      <div ref={fitRef} className="relative m-3 grid min-h-0 flex-1 place-items-center md:m-5 short:my-2">
        {compare === "side" ? (
          <div className={cn("absolute inset-0 flex items-center justify-center gap-4", sideVertical && "flex-col")}>
            {[
              { src: original, label: revealUrls ? "原图 · 同样处理" : "原图", processed: false },
              { src: processed, label: revealUrls ? "水印图 · 同样处理" : "处理后", processed: true },
            ].map((p) => (
              <figure key={p.label} className="flex flex-col items-center gap-1.5">
                <div className="checkerboard overflow-hidden rounded-lg shadow-sm" style={{ width: pane.w, height: pane.h }}>
                  {p.processed ? (
                    processedNode("size-full object-contain")
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.src} alt={p.label} className="size-full object-contain" draggable={false} />
                  )}
                </div>
                <figcaption className="text-xs leading-4 text-foreground-muted">{p.label}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div
            ref={frame}
            className={cn(
              "checkerboard absolute touch-none overflow-hidden rounded-lg shadow-sm select-none",
              loupe ? "cursor-crosshair" : compare === "slider" && "cursor-ew-resize"
            )}
            style={{ width: fitSize.w, height: fitSize.h }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={(e) => e.pointerType === "mouse" && setPos(null)}
          >
            {compare === "result" ? (
              processedNode("absolute inset-0 size-full object-contain")
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={original} alt="原图" className="absolute inset-0 size-full object-contain" draggable={false} />
            )}
            {compare === "slider" && (
              <>
                {processedNode("absolute inset-0 size-full object-contain", `inset(0 0 0 ${split}%)`)}
                <div className="pointer-events-none absolute inset-y-0 z-10 w-8 -translate-x-1/2" style={{ left: `${split}%` }}>
                  <div className="mx-auto h-full w-px bg-background shadow-[0_0_0_1px_var(--border-strong)]" />
                  <div className="absolute top-1/2 left-1/2 grid size-8 -translate-1/2 place-items-center rounded-full bg-background text-xs text-foreground-strong shadow-md">
                    ⇆
                  </div>
                </div>
                <span className="pointer-events-none absolute top-2 left-2 rounded bg-background-inverse/60 px-1.5 py-0.5 text-[10px] text-foreground-inverse">
                  {revealUrls ? "原图 · 同样处理" : "原图"}
                </span>
                <span className="pointer-events-none absolute top-2 right-2 rounded bg-background-inverse/60 px-1.5 py-0.5 text-[10px] text-foreground-inverse">
                  {revealUrls ? "水印图 · 同样处理" : "处理后"}
                </span>
              </>
            )}
            {loupe && <Loupe src={processed} altSrc={original} live={liveSurface} pos={pos} zoom={zoom} />}
          </div>
        )}
        {pinned && (
          <div className="absolute top-0 left-1/2 z-10 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-background/90 py-1 pr-1 pl-3 text-xs text-foreground-strong shadow-sm backdrop-blur-sm">
            <span className="truncate">此图固定使用模板「{pinned.name}」，参数面板的修改不影响它</span>
            <button
              className="shrink-0 rounded-full bg-background-muted px-2 py-0.5 text-foreground-intense hover:bg-background-strong"
              onClick={() => setAssetTemplate(asset.id, undefined)}
            >
              改为跟随
            </button>
          </div>
        )}
        {asset.status === "error" && (
          <div className="absolute bottom-2 max-w-[calc(100%-1rem)] rounded-lg bg-error-subtle px-3 py-2 text-xs break-all text-foreground-strong">
            处理失败：{asset.error}
          </div>
        )}
      </div>
    </div>
  )
}
