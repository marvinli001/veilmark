import type { Anchor, LayoutSpec, TemplateContext } from "./types"

/** 纯几何排版：不依赖 Canvas，可单测、可在 Worker 中复用（显性水印与伪隐性掩膜共用） */

export interface Placement {
  /** 元素中心点（像素） */
  x: number
  y: number
  /** 弧度 */
  angle: number
}

export const ANCHORS: Anchor[] = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]

export function anchorPoint(
  anchor: Anchor,
  W: number,
  H: number,
  itemW: number,
  itemH: number,
  margin: number
): { x: number; y: number } {
  const col = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 2 : 1
  const row = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 2 : 1
  const x = col === 0 ? margin + itemW / 2 : col === 2 ? W - margin - itemW / 2 : W / 2
  const y = row === 0 ? margin + itemH / 2 : row === 2 ? H - margin - itemH / 2 : H / 2
  return { x, y }
}

/**
 * @param scoreAnchor 可选：smart 锚点的代价函数（越小越好），通常是该区域的纹理活跃度
 */
export function computePlacements(
  spec: LayoutSpec,
  W: number,
  H: number,
  itemW: number,
  itemH: number,
  scoreAnchor?: (a: Anchor, rect: { x: number; y: number; w: number; h: number }) => number
): Placement[] {
  const short = Math.min(W, H)
  const angle = (spec.rotation * Math.PI) / 180
  const ox = (spec.offsetX / 100) * short
  const oy = (spec.offsetY / 100) * short

  if (spec.mode === "single") {
    const margin = (spec.margin / 100) * short
    // 旋转后的包围盒尺寸，保证贴边时不被裁掉
    const bw = Math.abs(itemW * Math.cos(angle)) + Math.abs(itemH * Math.sin(angle))
    const bh = Math.abs(itemW * Math.sin(angle)) + Math.abs(itemH * Math.cos(angle))
    let anchor: Anchor = spec.anchor === "smart" ? "bottom-right" : spec.anchor
    if (spec.anchor === "smart" && scoreAnchor) {
      let best = Infinity
      for (const a of ANCHORS) {
        if (a === "center") continue // 智能模式不压主体
        const p = anchorPoint(a, W, H, bw, bh, margin)
        const cost = scoreAnchor(a, { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh })
        if (cost < best) {
          best = cost
          anchor = a
        }
      }
    }
    const p = anchorPoint(anchor, W, H, bw, bh, margin)
    return [{ x: p.x + ox, y: p.y + oy, angle }]
  }

  const cellW = itemW * (1 + Math.max(0, spec.gapX))
  const cellH = itemH * (1 + Math.max(0, spec.gapY))
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const reach = Math.hypot(W, H) / 2 + Math.hypot(cellW, cellH)
  const radius = Math.hypot(itemW, itemH) / 2
  const out: Placement[] = []
  const emit = (u: number, v: number) => {
    const x = W / 2 + ox + u * cos - v * sin
    const y = H / 2 + oy + u * sin + v * cos
    if (x < -radius || y < -radius || x > W + radius || y > H + radius) return
    out.push({ x, y, angle })
  }

  if (spec.mode === "band") {
    for (let u = -reach; u <= reach; u += cellW) emit(u, 0)
    return out
  }

  const rows = Math.ceil(reach / cellH)
  const cols = Math.ceil(reach / cellW) + 1
  for (let r = -rows; r <= rows; r++) {
    const shift = (((r % 2) + 2) % 2) * spec.stagger * cellW
    for (let c = -cols; c <= cols; c++) emit(c * cellW + shift, r * cellH)
  }
  return out
}

/** 模板变量替换，未知变量保留原样便于用户发现拼写错误 */
export function resolveTemplate(content: string, ctx: TemplateContext): string {
  const d = ctx.date ?? new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const vars: Record<string, string | undefined> = {
    author: ctx.author,
    filename: ctx.filename?.replace(/\.[^.]+$/, ""),
    index: ctx.index != null ? String(ctx.index + 1).padStart(3, "0") : undefined,
    width: ctx.width != null ? String(ctx.width) : undefined,
    height: ctx.height != null ? String(ctx.height) : undefined,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    year: String(d.getFullYear()),
    id: ctx.id,
  }
  return content.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
}
