import { createPlane, type Plane } from "../core/image"
import { computePlacements, resolveTemplate, type Placement } from "./layout"
import type { Anchor, LayoutSpec, TemplateContext, TextStyle, VisibleLayer } from "./types"

/** 主线程与 Worker 通用的 2D 上下文类型 */
export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export interface Stamp {
  canvas: OffscreenCanvas
  width: number
  height: number
}

export interface RenderAssets {
  /** 图片水印位图，key 为 ImageStampStyle.src */
  images?: Map<string, ImageBitmap>
}

function ctx2d(c: OffscreenCanvas) {
  const ctx = c.getContext("2d")
  if (!ctx) throw new Error("OffscreenCanvas 2D 上下文不可用")
  return ctx
}

function fontString(s: TextStyle, px: number) {
  return `${s.italic ? "italic " : ""}${s.fontWeight} ${px}px ${s.fontFamily}`
}

/**
 * 把一段文字连同描边/阴影/底板渲染成“印章”，平铺时只绘制一次再复用，
 * 数百个平铺元素也能保持 60fps 预览。
 */
export function buildTextStamp(
  style: TextStyle,
  text: string,
  shortSide: number,
  opts: { maskOnly?: boolean; colorOverride?: string } = {}
): Stamp {
  const px = Math.max(4, (shortSide * style.fontSize) / 100)
  const lines = (style.uppercase ? text.toUpperCase() : text).split("\n")
  const probe = ctx2d(new OffscreenCanvas(1, 1))
  probe.font = fontString(style, px)
  if ("letterSpacing" in probe) probe.letterSpacing = `${style.letterSpacing * px}px`
  const widths = lines.map((l) => probe.measureText(l).width)
  const textW = Math.max(1, ...widths)
  const lineH = px * style.lineHeight
  const textH = lineH * lines.length

  const bg = style.background.enabled && !opts.maskOnly
  const padX = bg ? style.background.paddingX * px : 0
  const padY = bg ? style.background.paddingY * px : 0
  const strokeW = style.stroke.enabled ? style.stroke.width * px : 0
  const sh = style.shadow.enabled && !opts.maskOnly ? style.shadow : null
  const fx = strokeW + (sh ? sh.blur * px * 2 + Math.abs(sh.offsetX * px) : 0)
  const fy = strokeW + (sh ? sh.blur * px * 2 + Math.abs(sh.offsetY * px) : 0)

  const boxW = textW + padX * 2
  const boxH = textH + padY * 2
  const cw = Math.ceil(boxW + fx * 2)
  const ch = Math.ceil(boxH + fy * 2)
  const canvas = new OffscreenCanvas(cw, ch)
  const ctx = ctx2d(canvas)
  const ox = fx
  const oy = fy

  if (bg) {
    ctx.fillStyle = style.background.color
    ctx.beginPath()
    ctx.roundRect(ox, oy, boxW, boxH, style.background.radius * px)
    ctx.fill()
  }

  ctx.font = fontString(style, px)
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${style.letterSpacing * px}px`
  ctx.textBaseline = "middle"
  ctx.textAlign = style.align
  const ax = style.align === "left" ? ox + padX : style.align === "right" ? ox + padX + textW : ox + padX + textW / 2

  let fill: string | CanvasGradient
  if (opts.maskOnly) fill = "#fff"
  else if (opts.colorOverride) fill = opts.colorOverride
  else if (style.fill.type === "solid") fill = style.fill.color
  else {
    const a = (style.fill.angle * Math.PI) / 180
    const cx = ox + boxW / 2
    const cy = oy + boxH / 2
    const r = Math.hypot(boxW, boxH) / 2
    const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    for (const s of style.fill.stops) g.addColorStop(s.offset, s.color)
    fill = g
  }

  if (sh) {
    ctx.shadowColor = sh.color
    ctx.shadowBlur = sh.blur * px
    ctx.shadowOffsetX = sh.offsetX * px
    ctx.shadowOffsetY = sh.offsetY * px
  }
  lines.forEach((line, i) => {
    const y = oy + padY + lineH * (i + 0.5)
    if (strokeW > 0) {
      ctx.lineJoin = "round"
      ctx.lineWidth = strokeW * 2
      ctx.strokeStyle = opts.maskOnly ? "#fff" : style.stroke.color
      ctx.strokeText(line, ax, y)
    }
    ctx.fillStyle = fill
    ctx.fillText(line, ax, y)
  })
  return { canvas, width: cw, height: ch }
}

export function buildImageStamp(bitmap: ImageBitmap, widthPct: number, shortSide: number): Stamp {
  const w = Math.max(1, Math.round((shortSide * widthPct) / 100))
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = ctx2d(canvas)
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(bitmap, 0, 0, w, h)
  return { canvas, width: w, height: h }
}

function drawStamps(ctx: Ctx2D, stamp: Stamp, placements: Placement[]) {
  for (const p of placements) {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.angle)
    ctx.drawImage(stamp.canvas, -stamp.width / 2, -stamp.height / 2)
    ctx.restore()
  }
}

/** 在 64px 缩略图上估计区域纹理量，用于 smart 锚点与自动反色 */
function makeRegionStats(ctx: Ctx2D, W: number, H: number) {
  const sw = 64
  const sh = Math.max(1, Math.round((H / W) * sw))
  const thumb = new OffscreenCanvas(sw, sh)
  const t = ctx2d(thumb)
  t.drawImage(ctx.canvas as CanvasImageSource, 0, 0, sw, sh)
  const d = t.getImageData(0, 0, sw, sh).data
  const lum = new Float32Array(sw * sh)
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  const region = (r: { x: number; y: number; w: number; h: number }) => {
    const x0 = Math.max(0, Math.floor((r.x / W) * sw))
    const y0 = Math.max(0, Math.floor((r.y / H) * sh))
    const x1 = Math.min(sw - 1, Math.ceil(((r.x + r.w) / W) * sw))
    const y1 = Math.min(sh - 1, Math.ceil(((r.y + r.h) / H) * sh))
    let mean = 0
    let grad = 0
    let n = 0
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = lum[y * sw + x]
        mean += v
        grad += Math.abs(v - lum[y * sw + x + 1]) + Math.abs(v - lum[(y + 1) * sw + x])
        n++
      }
    return n ? { mean: mean / n, activity: grad / n } : { mean: 128, activity: 0 }
  }
  return region
}

/** 把一个显性水印图层合成到画布上（已在画布上的内容视为底图） */
export function renderVisibleLayer(
  ctx: Ctx2D,
  layer: VisibleLayer,
  tpl: TemplateContext,
  assets: RenderAssets = {}
): void {
  if (!layer.enabled || layer.opacity <= 0) return
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const short = Math.min(W, H)

  const makeStamp = (colorOverride?: string): Stamp | null => {
    if (layer.kind === "image") {
      const bmp = layer.image && assets.images?.get(layer.image.src)
      return bmp ? buildImageStamp(bmp, layer.image!.width, short) : null
    }
    const text = resolveTemplate(layer.text.content, { ...tpl, width: W, height: H })
    return text.trim() ? buildTextStamp(layer.text, text, short, { colorOverride }) : null
  }

  let stamp = makeStamp()
  if (!stamp) return
  const needStats = layer.layout.mode === "single" && (layer.layout.anchor === "smart" || layer.autoContrast)
  const stats = needStats ? makeRegionStats(ctx, W, H) : null
  const score = stats ? (_a: Anchor, r: { x: number; y: number; w: number; h: number }) => stats(r).activity : undefined
  const placements = computePlacements(layer.layout, W, H, stamp.width, stamp.height, score)

  if (stats && layer.autoContrast && layer.kind === "text" && placements[0]) {
    const p = placements[0]
    const { mean } = stats({ x: p.x - stamp.width / 2, y: p.y - stamp.height / 2, w: stamp.width, h: stamp.height })
    stamp = makeStamp(mean > 150 ? "rgba(17,17,17,1)" : "rgba(255,255,255,1)") ?? stamp
  }

  // 先把所有印章画到独立图层，再整体按不透明度/混合模式合成，避免平铺重叠处透明度叠加
  const layerCanvas = new OffscreenCanvas(W, H)
  drawStamps(ctx2d(layerCanvas), stamp, placements)
  ctx.save()
  ctx.globalAlpha = layer.opacity
  ctx.globalCompositeOperation = layer.blend
  ctx.drawImage(layerCanvas, 0, 0)
  ctx.restore()
}

/**
 * 伪隐性水印的“信息掩膜”：与显性水印共用排版引擎，只取 alpha。
 * 返回 0–1 浮点平面。
 */
export function renderTextMask(
  W: number,
  H: number,
  style: TextStyle,
  layout: LayoutSpec,
  tpl: TemplateContext
): Plane {
  const short = Math.min(W, H)
  const text = resolveTemplate(style.content, { ...tpl, width: W, height: H })
  const stamp = buildTextStamp(style, text, short, { maskOnly: true })
  const canvas = new OffscreenCanvas(W, H)
  const ctx = ctx2d(canvas)
  drawStamps(ctx, stamp, computePlacements(layout, W, H, stamp.width, stamp.height))
  const d = ctx.getImageData(0, 0, W, H).data
  const mask = createPlane(W, H)
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = d[i * 4 + 3] / 255
  return mask
}
