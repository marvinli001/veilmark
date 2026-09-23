"use client"

import { Button, buttonVariants } from "@appica/ui-react/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu"
import { Input } from "@appica/ui-react/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@appica/ui-react/select"
import { Switch } from "@appica/ui-react/switch"
import { Textarea } from "@appica/ui-react/textarea"
import { Braces, Image as ImageIcon, Plus, Sparkles, Trash2, Type } from "lucide-react"
import { useState } from "react"

import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ANCHORS } from "@/lib/watermark/visible/layout"
import type { Anchor, BlendMode, VisibleLayer } from "@/lib/watermark/visible/types"
import { previewWorker } from "@/lib/workers/client"

import { ColorRow, FieldRow, More, Section, Segmented, SliderRow, SwitchRow } from "../controls"

const FONTS = [
  { value: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif", label: "无衬线 · Inter / 苹方" },
  { value: "'Songti SC', 'Noto Serif SC', 'SimSun', serif", label: "衬线 · 宋体" },
  { value: "'Kaiti SC', 'STKaiti', 'KaiTi', serif", label: "楷体" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'SF Mono', Menlo, Consolas, monospace", label: "等宽" },
  { value: "Impact, 'Arial Black', sans-serif", label: "Impact 粗黑" },
]

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }))

const BLENDS: Array<{ value: BlendMode; label: string }> = [
  { value: "source-over", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "screen", label: "滤色" },
  { value: "overlay", label: "叠加" },
  { value: "soft-light", label: "柔光" },
  { value: "hard-light", label: "强光" },
  { value: "difference", label: "差值" },
  { value: "exclusion", label: "排除" },
  { value: "luminosity", label: "明度" },
]

const VARS = [
  { value: "{author}", label: "署名" },
  { value: "{date}", label: "日期" },
  { value: "{time}", label: "时间" },
  { value: "{year}", label: "年份" },
  { value: "{filename}", label: "文件名" },
  { value: "{index}", label: "批次序号" },
  { value: "{width}", label: "宽度" },
  { value: "{height}", label: "高度" },
  { value: "{id}", label: "盲水印指纹" },
]

const ANCHOR_GLYPH: Record<Anchor, string> = {
  "top-left": "↖",
  top: "↑",
  "top-right": "↗",
  left: "←",
  center: "•",
  right: "→",
  "bottom-left": "↙",
  bottom: "↓",
  "bottom-right": "↘",
}

function AnchorPicker({ value, onChange }: { value: Anchor | "smart"; onChange: (a: Anchor | "smart") => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-background-muted p-1">
        {ANCHORS.map((a) => (
          <button
            key={a}
            aria-label={a}
            aria-pressed={value === a}
            onClick={() => onChange(a)}
            className={cn(
              "grid size-8 place-items-center rounded-md text-xs text-foreground-muted outline-ring-primary hover:text-foreground-intense",
              value === a && "bg-background text-foreground-intense shadow-xs"
            )}
          >
            {ANCHOR_GLYPH[a]}
          </button>
        ))}
      </div>
      <Button size="sm" variant={value === "smart" ? "soft" : "ghost"} onClick={() => onChange("smart")}>
        <Sparkles className="size-3.5" /> 智能避让
      </Button>
    </div>
  )
}

function LayerEditor({ layer }: { layer: VisibleLayer }) {
  const patchLayer = useStudio((s) => s.patchLayer)
  const patch = (fn: (l: VisibleLayer) => VisibleLayer) => patchLayer(layer.id, fn)
  const t = layer.text
  const L = layer.layout
  const setText = (p: Partial<VisibleLayer["text"]>) => patch((l) => ({ ...l, text: { ...l.text, ...p } }))
  const setLayout = (p: Partial<VisibleLayer["layout"]>) => patch((l) => ({ ...l, layout: { ...l.layout, ...p } }))
  const isText = layer.kind === "text"

  return (
    <>
      {isText ? (
        <Section
          title="文字"
          action={
            <DropdownMenu size="sm">
              <DropdownMenuTrigger className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-my-1 gap-1 px-2 text-xs")}>
                <Braces className="size-3.5" /> 插入变量
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {VARS.map((v) => (
                  <DropdownMenuItem key={v.value} onClick={() => setText({ content: t.content + v.value })}>
                    <span className="flex-1">{v.label}</span>
                    <span className="font-mono text-[11px] text-foreground-subtle">{v.value}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        >
          <Textarea rows={2} value={t.content} onChange={(e) => setText({ content: e.target.value })} aria-label="水印文字" />
        </Section>
      ) : (
        <Section title="图片" description="透明 PNG / SVG 效果最好，例如品牌 Logo">
          <Input
            type="file"
            accept="image/png,image/svg+xml,image/webp"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const src = await new Promise<string>((r) => {
                const fr = new FileReader()
                fr.onload = () => r(String(fr.result))
                fr.readAsDataURL(f)
              })
              await previewWorker().registerImageAsset(src, f)
              patch((l) => ({ ...l, image: { src, width: l.image?.width ?? 18 } }))
            }}
          />
          <SliderRow live="visible"
            label="宽度"
            value={layer.image?.width ?? 18}
            min={3}
            max={80}
            onChange={(v) => patch((l) => ({ ...l, image: { src: l.image?.src ?? "", width: v } }))}
            format={(v) => `${v}%`}
          />
          <SliderRow live="visible" label="不透明度" value={layer.opacity} min={0} max={1} step={0.01} onChange={(opacity) => patch((l) => ({ ...l, opacity }))} format={(v) => `${Math.round(v * 100)}%`} />
        </Section>
      )}

      {isText && (
        <Section title="样式">
          <FieldRow label="字体">
            <Select value={t.fontFamily} onValueChange={(v) => v && setText({ fontFamily: String(v) })} items={FONTS}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONTS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    <span style={{ fontFamily: f.value }}>{f.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          {t.fill.type === "solid" ? (
            <ColorRow label="颜色" value={t.fill.color} onChange={(color) => setText({ fill: { type: "solid", color } })} />
          ) : (
            <FieldRow label="颜色">
              <span className="text-xs text-foreground-muted">渐变（在“更多样式”里调整）</span>
            </FieldRow>
          )}
          <SliderRow live="visible" label="字号" value={t.fontSize} min={0.5} max={25} step={0.1} onChange={(fontSize) => setText({ fontSize })} format={(v) => `${v.toFixed(1)}%`} />
          <SliderRow live="visible" label="不透明度" value={layer.opacity} min={0} max={1} step={0.01} onChange={(opacity) => patch((l) => ({ ...l, opacity }))} format={(v) => `${Math.round(v * 100)}%`} />
        </Section>
      )}

      <Section title="位置">
        <Segmented
          value={L.mode}
          onChange={(mode) => setLayout({ mode })}
          options={[
            { value: "single", label: "单个" },
            { value: "tile", label: "平铺" },
            { value: "band", label: "斜带" },
          ]}
        />
        {L.mode === "single" ? (
          <AnchorPicker value={L.anchor} onChange={(anchor) => setLayout({ anchor })} />
        ) : (
          <SliderRow live="visible"
            label="间距"
            value={L.gapX}
            min={0}
            max={5}
            step={0.05}
            onChange={(gapX) => setLayout({ gapX })}
            format={(v) => `${v.toFixed(2)}×`}
          />
        )}
        {L.mode === "tile" && (
          <SliderRow live="visible"
            label="行距"
            value={L.gapY}
            min={0}
            max={8}
            step={0.05}
            onChange={(gapY) => setLayout({ gapY })}
            format={(v) => `${v.toFixed(2)}×`}
          />
        )}
        <SliderRow live="visible" label="旋转" value={L.rotation} min={-90} max={90} onChange={(rotation) => setLayout({ rotation })} format={(v) => `${v}°`} />
      </Section>

      <More id="visible-more" label={isText ? "更多样式与微调" : "混合与微调"}>
        {isText && (
          <Section title="文字排版">
            <FieldRow label="字重">
              <div className="flex items-center gap-2">
                <Select value={String(t.fontWeight)} onValueChange={(v) => v && setText({ fontWeight: Number(v) })} items={WEIGHTS}>
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEIGHTS.map((w) => (
                      <SelectItem key={w.value} value={w.value}>
                        {w.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant={t.italic ? "soft" : "ghost"} onClick={() => setText({ italic: !t.italic })} className="italic" aria-pressed={t.italic} aria-label="斜体">
                  I
                </Button>
                <Button size="sm" variant={t.uppercase ? "soft" : "ghost"} onClick={() => setText({ uppercase: !t.uppercase })} aria-pressed={t.uppercase} aria-label="全部大写">
                  AA
                </Button>
              </div>
            </FieldRow>
            <FieldRow label="对齐">
              <Segmented
                size="sm"
                value={t.align}
                onChange={(align) => setText({ align })}
                options={[
                  { value: "left", label: "左" },
                  { value: "center", label: "中" },
                  { value: "right", label: "右" },
                ]}
              />
            </FieldRow>
            <SliderRow live="visible" label="字间距" value={t.letterSpacing} min={-0.1} max={1} step={0.01} onChange={(letterSpacing) => setText({ letterSpacing })} format={(v) => `${v.toFixed(2)}em`} />
            <SliderRow live="visible" label="行高" value={t.lineHeight} min={0.8} max={3} step={0.05} onChange={(lineHeight) => setText({ lineHeight })} format={(v) => v.toFixed(2)} />
          </Section>
        )}

        {isText && (
          <Section title="填充与效果">
            <FieldRow label="填充">
              <Segmented
                size="sm"
                value={t.fill.type}
                onChange={(type) =>
                  setText({
                    fill:
                      type === "solid"
                        ? { type: "solid", color: t.fill.type === "solid" ? t.fill.color : "#ffffff" }
                        : { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#9ca3af" }] },
                  })
                }
                options={[
                  { value: "solid", label: "纯色" },
                  { value: "linear", label: "渐变" },
                ]}
              />
            </FieldRow>
            {t.fill.type === "linear" && (
              <>
                {t.fill.stops.map((s, i) => (
                  <ColorRow
                    key={i}
                    label={i === 0 ? "起始色" : "结束色"}
                    value={s.color}
                    onChange={(color) =>
                      t.fill.type === "linear" &&
                      setText({ fill: { ...t.fill, stops: t.fill.stops.map((x, j) => (j === i ? { ...x, color } : x)) } })
                    }
                  />
                ))}
                <SliderRow live="visible"
                  label="渐变角度"
                  value={t.fill.angle}
                  min={0}
                  max={360}
                  onChange={(angle) => t.fill.type === "linear" && setText({ fill: { ...t.fill, angle } })}
                  format={(v) => `${v}°`}
                />
              </>
            )}
            <SwitchRow label="描边" checked={t.stroke.enabled} onChange={(enabled) => setText({ stroke: { ...t.stroke, enabled } })} />
            {t.stroke.enabled && (
              <>
                <ColorRow label="描边色" value={t.stroke.color} onChange={(color) => setText({ stroke: { ...t.stroke, color } })} />
                <SliderRow live="visible" label="描边宽" value={t.stroke.width} min={0.01} max={0.3} step={0.01} onChange={(width) => setText({ stroke: { ...t.stroke, width } })} format={(v) => `${v.toFixed(2)}em`} />
              </>
            )}
            <SwitchRow label="投影" checked={t.shadow.enabled} onChange={(enabled) => setText({ shadow: { ...t.shadow, enabled } })} />
            {t.shadow.enabled && (
              <>
                <ColorRow label="投影色" value={t.shadow.color} onChange={(color) => setText({ shadow: { ...t.shadow, color } })} />
                <SliderRow live="visible" label="模糊" value={t.shadow.blur} min={0} max={1} step={0.01} onChange={(blur) => setText({ shadow: { ...t.shadow, blur } })} format={(v) => `${v.toFixed(2)}em`} />
                <SliderRow live="visible" label="Y 偏移" value={t.shadow.offsetY} min={-0.5} max={0.5} step={0.01} onChange={(offsetY) => setText({ shadow: { ...t.shadow, offsetY } })} format={(v) => `${v.toFixed(2)}em`} />
              </>
            )}
            <SwitchRow label="底板" checked={t.background.enabled} onChange={(enabled) => setText({ background: { ...t.background, enabled } })} />
            {t.background.enabled && (
              <>
                <ColorRow label="底板色" value={t.background.color} onChange={(color) => setText({ background: { ...t.background, color } })} />
                <SliderRow live="visible" label="圆角" value={t.background.radius} min={0} max={2} step={0.05} onChange={(radius) => setText({ background: { ...t.background, radius } })} format={(v) => `${v.toFixed(2)}em`} />
              </>
            )}
          </Section>
        )}

        <Section title="合成与微调">
          <FieldRow label="混合模式">
            <Select value={layer.blend} onValueChange={(v) => v && patch((l) => ({ ...l, blend: v as BlendMode }))} items={BLENDS}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLENDS.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          {L.mode === "single" && isText && (
            <SwitchRow label="自动反色" hint="按落点背景亮度切换黑/白，保证可读" checked={layer.autoContrast} onChange={(autoContrast) => patch((l) => ({ ...l, autoContrast }))} />
          )}
          {L.mode === "single" && (
            <SliderRow live="visible" label="边距" value={L.margin} min={0} max={20} step={0.5} onChange={(margin) => setLayout({ margin })} format={(v) => `${v}%`} />
          )}
          {L.mode === "tile" && (
            <SliderRow live="visible" label="隔行错位" value={L.stagger} min={0} max={1} step={0.05} onChange={(stagger) => setLayout({ stagger })} format={(v) => `${Math.round(v * 100)}%`} />
          )}
          <SliderRow live="visible" label="水平偏移" value={L.offsetX} min={-50} max={50} step={0.5} onChange={(offsetX) => setLayout({ offsetX })} format={(v) => `${v}%`} />
          <SliderRow live="visible" label="垂直偏移" value={L.offsetY} min={-50} max={50} step={0.5} onChange={(offsetY) => setLayout({ offsetY })} format={(v) => `${v}%`} />
        </Section>
      </More>
    </>
  )
}

function AddLayerMenu({ onAdd }: { onAdd: (kind: VisibleLayer["kind"]) => void }) {
  return (
    <DropdownMenu size="sm">
      <DropdownMenuTrigger className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-my-1 gap-1 px-2 text-xs")}>
        <Plus className="size-3.5" /> 添加
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => onAdd("text")}>
          <Type className="size-3.5" /> 文字水印
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAdd("image")}>
          <ImageIcon className="size-3.5" /> 图片 / Logo
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function VisiblePanel() {
  const { job, addLayer, removeLayer, patchLayer } = useStudio()
  const [activeLayer, setActiveLayer] = useState<string | null>(job.visible[0]?.id ?? null)
  const current = job.visible.find((l) => l.id === activeLayer) ?? job.visible[0]
  const add = (kind: VisibleLayer["kind"]) => {
    addLayer(kind)
    // 新图层追加在末尾，添加后直接进入编辑
    const layers = useStudio.getState().job.visible
    setActiveLayer(layers[layers.length - 1]?.id ?? null)
  }

  if (!job.visible.length) {
    return (
      <Section title="显性水印" description="看得见的文字或 Logo，可单个、平铺或斜带排布。">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => add("text")}>
            <Type className="size-4" /> 添加文字
          </Button>
          <Button variant="outline" onClick={() => add("image")}>
            <ImageIcon className="size-4" /> 添加 Logo
          </Button>
        </div>
      </Section>
    )
  }

  return (
    <div>
      <Section title="显性水印" action={<AddLayerMenu onAdd={add} />}>
        <ul className="-mx-2 flex flex-col gap-0.5">
          {job.visible.map((l) => (
            <li
              key={l.id}
              role="button"
              tabIndex={0}
              aria-current={current?.id === l.id}
              onClick={() => setActiveLayer(l.id)}
              onKeyDown={(e) => e.key === "Enter" && setActiveLayer(l.id)}
              className={cn(
                "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 outline-ring-primary",
                job.visible.length > 1 && current?.id === l.id ? "bg-background-muted" : "hover:bg-background-subtle"
              )}
            >
              {l.kind === "text" ? <Type className="size-3.5 shrink-0 text-foreground-muted" /> : <ImageIcon className="size-3.5 shrink-0 text-foreground-muted" />}
              <span className={cn("flex-1 truncate text-sm", l.enabled ? "text-foreground-strong" : "text-foreground-subtle")}>
                {l.kind === "text" ? l.text.content || l.name : l.name}
              </span>
              <button
                aria-label="删除图层"
                className="grid size-8 place-items-center rounded-md text-foreground-subtle outline-ring-primary hover:text-error-emphasis"
                onClick={(e) => {
                  e.stopPropagation()
                  removeLayer(l.id)
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
              <Switch
                size="sm"
                checked={l.enabled}
                aria-label={l.enabled ? "隐藏此水印" : "显示此水印"}
                onCheckedChange={(enabled) => patchLayer(l.id, (x) => ({ ...x, enabled }))}
                onClick={(e) => e.stopPropagation()}
              />
            </li>
          ))}
        </ul>
      </Section>
      {current && <LayerEditor key={current.id} layer={current} />}
    </div>
  )
}
