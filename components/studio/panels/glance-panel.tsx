"use client"

import { Input } from "@appica/ui-react/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@appica/ui-react/select"
import { Switch } from "@appica/ui-react/switch"

import { useStudio } from "@/lib/store"
import { REVEAL_LABELS, type RevealKind } from "@/lib/watermark/glance/simulate"
import { glancePreset, type GlanceConfig, type GlanceMode } from "@/lib/watermark/glance/types"

import { Callout, FieldRow, Section, Segmented, SliderRow, SwitchRow } from "../controls"

const MODE_COPY: Record<GlanceMode, string> = {
  daily: "低频色调 + 等亮度色度：扛截图与压缩；对比度/饱和度/去色等调色后变明显。",
  print: "相位反转光栅 + 防复印底纹：适屏浏览被平均掉；重采样、打印加网后浮现。需无损导出。",
  screenshot: "更大字号与更低频的编码，兼顾截图后仍留存；建议同时开启盲水印用于追溯。",
  custom: "自由组合四个触发层。",
}

const AXIS_ITEMS = [
  { value: "auto", label: "自动（避开主色）" },
  { value: "blue-yellow", label: "蓝–黄（最隐蔽）" },
  { value: "red-green", label: "红–绿（自动降幅）" },
]

const QUICK_REVEALS: RevealKind[] = ["nearest-50", "print", "contrast", "saturation", "desaturate-avg"]

export function GlancePanel() {
  const { job, patchGlance, setReveal } = useStudio()
  const g = job.glance
  const set = (p: Partial<GlanceConfig>) => patchGlance((x) => ({ ...x, ...p, mode: p.mode ?? "custom" }))

  return (
    <div>
      <Section
        title="智能伪隐性水印"
        description="日常浏览几乎无感，被盗用于打印/放大/调色时浮现版权文字"
        action={<Switch checked={g.enabled} onCheckedChange={(enabled) => patchGlance((x) => ({ ...x, enabled }))} />}
      >
        <Segmented
          value={g.mode}
          onChange={(mode) => {
            if (mode === "custom") return set({ mode })
            // 切换预设时保留用户写好的文字内容
            patchGlance((x) => ({ ...glancePreset(mode), enabled: x.enabled, text: { ...glancePreset(mode).text, content: x.text.content } }))
          }}
          options={[
            { value: "daily", label: "日常隐藏" },
            { value: "print", label: "打印显形" },
            { value: "screenshot", label: "抗截图" },
            { value: "custom", label: "自定义" },
          ]}
        />
        <p className="text-xs leading-relaxed text-foreground-muted">{MODE_COPY[g.mode]}</p>
      </Section>

      <Section title="隐藏信息">
        <FieldRow label="文字">
          <Input value={g.text.content} onChange={(e) => patchGlance((x) => ({ ...x, text: { ...x.text, content: e.target.value } }))} />
        </FieldRow>
        <SliderRow label="字号" value={g.text.fontSize} min={3} max={25} step={0.5} onChange={(fontSize) => patchGlance((x) => ({ ...x, text: { ...x.text, fontSize } }))} format={(v) => `${v}%`} />
        <SliderRow label="旋转" value={g.layout.rotation} min={-90} max={90} onChange={(rotation) => patchGlance((x) => ({ ...x, layout: { ...x.layout, rotation } }))} format={(v) => `${v}°`} />
        <SliderRow label="密度" value={g.layout.gapY} min={0.2} max={4} step={0.05} onChange={(gapY) => patchGlance((x) => ({ ...x, layout: { ...x.layout, gapY, gapX: gapY * 0.4 } }))} format={(v) => `${v.toFixed(2)}×`} />
        <SliderRow label="边缘羽化" value={g.feather} min={0} max={8} step={0.5} onChange={(feather) => set({ feather })} format={(v) => `${v}‰`} />
        <SliderRow label="纹理自适应" value={g.adaptive} min={0} max={1} step={0.05} onChange={(adaptive) => set({ adaptive })} format={(v) => `${Math.round(v * 100)}%`} />
      </Section>

      <Section title="触发层" description="每层对应一种盗用场景；振幅单位是 8-bit 灰阶">
        <SwitchRow label="相位反转光栅" hint="重采样 / 打印加网 / 锐化 → 显形" checked={g.grating.enabled} onChange={(enabled) => set({ grating: { ...g.grating, enabled } })} />
        {g.grating.enabled && (
          <>
            <SliderRow label="振幅" value={g.grating.amplitude} min={0.5} max={12} step={0.5} onChange={(amplitude) => set({ grating: { ...g.grating, amplitude } })} />
            <FieldRow label="载波">
              <Segmented
                size="sm"
                value={g.grating.kind}
                onChange={(kind) => set({ grating: { ...g.grating, kind } })}
                options={[
                  { value: "checker", label: "棋盘（奈奎斯特）" },
                  { value: "lines", label: "斜线" },
                ]}
              />
            </FieldRow>
            {g.grating.kind === "lines" && (
              <>
                <SliderRow label="周期" value={g.grating.period} min={2} max={6} step={0.5} onChange={(period) => set({ grating: { ...g.grating, period } })} format={(v) => `${v}px`} />
                <SliderRow label="角度" value={g.grating.angle} min={0} max={180} onChange={(angle) => set({ grating: { ...g.grating, angle } })} format={(v) => `${v}°`} />
              </>
            )}
          </>
        )}
        <SwitchRow label="防复印底纹" hint="细网点 vs 粗网点，打印网点扩大 → 显形" checked={g.pantograph.enabled} onChange={(enabled) => set({ pantograph: { ...g.pantograph, enabled } })} />
        {g.pantograph.enabled && (
          <>
            <SliderRow label="振幅" value={g.pantograph.amplitude} min={0.5} max={12} step={0.5} onChange={(amplitude) => set({ pantograph: { ...g.pantograph, amplitude } })} />
            <SliderRow label="粗网周期" value={g.pantograph.coarsePeriod} min={3} max={10} onChange={(coarsePeriod) => set({ pantograph: { ...g.pantograph, coarsePeriod } })} format={(v) => `${v}px`} />
          </>
        )}
        <SwitchRow label="暗部色调偏移" hint="拉对比度 / 提亮阴影 → 显形" checked={g.tone.enabled} onChange={(enabled) => set({ tone: { ...g.tone, enabled } })} />
        {g.tone.enabled && (
          <>
            <SliderRow label="振幅" value={g.tone.amplitude} min={0.2} max={6} step={0.1} onChange={(amplitude) => set({ tone: { ...g.tone, amplitude } })} />
            <SliderRow label="暗部偏置" value={g.tone.shadowBias} min={0} max={1} step={0.05} onChange={(shadowBias) => set({ tone: { ...g.tone, shadowBias } })} format={(v) => `${Math.round(v * 100)}%`} />
          </>
        )}
        <SwitchRow label="等亮度色度偏移" hint="拉饱和度 / 平均法去色 → 显形" checked={g.chroma.enabled} onChange={(enabled) => set({ chroma: { ...g.chroma, enabled } })} />
        {g.chroma.enabled && (
          <>
            <SliderRow label="振幅" value={g.chroma.amplitude} min={0.5} max={16} step={0.5} onChange={(amplitude) => set({ chroma: { ...g.chroma, amplitude } })} />
            <FieldRow label="色度轴">
              <Select value={g.chroma.axis} onValueChange={(v) => v && set({ chroma: { ...g.chroma, axis: v as GlanceConfig["chroma"]["axis"] } })} items={AXIS_ITEMS}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AXIS_ITEMS.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </>
        )}
      </Section>

      <Section title="盗用模拟" description="导出前在画布上预演二次加工，确认水印会浮现">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_REVEALS.map((k) => (
            <button
              key={k}
              onClick={() => setReveal(k)}
              className="rounded-md bg-background-muted px-2 py-1 text-xs text-foreground-strong hover:bg-background-strong"
            >
              {REVEAL_LABELS[k]}
            </button>
          ))}
        </div>
        <Callout>
          高频层依赖逐像素结构：请用<strong>放大镜</strong>在 1:1 下检查，并以 PNG / 无损 WebP 导出。平台二次 JPEG
          压缩会抹除高频层，但低频层与盲水印仍在。
        </Callout>
      </Section>
    </div>
  )
}
