"use client"

import { Input } from "@appica/ui-react/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@appica/ui-react/select"
import { Switch } from "@appica/ui-react/switch"

import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { REVEAL_LABELS, type RevealKind } from "@/lib/watermark/glance/simulate"
import { glancePreset, type GlanceConfig, type GlanceMode } from "@/lib/watermark/glance/types"

import { FieldRow, More, Section, Segmented, SliderRow, SwitchRow } from "../controls"

const MODE_COPY: Record<GlanceMode, string> = {
  daily: "扛截图与压缩；被拉对比度、饱和度或去色时显形。",
  print: "适屏浏览时隐形；被缩放、打印或锐化后显形。需无损导出。",
  screenshot: "更大更低频的文字，截图后仍留存；建议同时开启盲水印。",
  hybrid: "保留打印显形，同时加强截图后仍留存的低频层；适屏更易察觉一些。需无损导出，建议开启盲水印。",
  custom: "已自定义触发层，可在下方“触发层”里调整。",
}

const AXIS_ITEMS = [
  { value: "auto", label: "自动（避开主色）" },
  { value: "blue-yellow", label: "蓝–黄（最隐蔽）" },
  { value: "red-green", label: "红–绿（自动降幅）" },
]

const QUICK_REVEALS: RevealKind[] = ["nearest-50", "print", "contrast", "saturation", "desaturate-avg"]

export function GlancePanel() {
  const { job, patchGlance, setReveal } = useStudio()
  const reveal = useStudio((s) => s.reveal)
  const g = job.glance
  const set = (p: Partial<GlanceConfig>) => patchGlance((x) => ({ ...x, ...p, mode: p.mode ?? "custom" }))

  return (
    <div>
      <Section
        title="伪隐性水印"
        description="日常浏览几乎看不见，被打印、放大或调色盗用时浮现版权文字。"
        action={<Switch checked={g.enabled} onCheckedChange={(enabled) => patchGlance((x) => ({ ...x, enabled }))} aria-label="开启伪隐性水印" />}
      />
      {g.enabled && (
        <>
          <Section title="场景">
            <Segmented
              value={g.mode}
              onChange={(mode) => {
                // 选项里没有“自定义”：它只在改动触发层后自动进入
                if (mode === "custom") return
                // 切换预设时保留用户写好的文字内容
                patchGlance((x) => ({ ...glancePreset(mode), enabled: x.enabled, text: { ...glancePreset(mode).text, content: x.text.content } }))
              }}
              options={[
                { value: "daily", label: "日常隐藏" },
                { value: "print", label: "打印显形" },
                { value: "screenshot", label: "抗截图" },
                { value: "hybrid", label: "打印+截图" },
              ]}
            />
            <p className="text-xs leading-relaxed text-foreground-muted">{MODE_COPY[g.mode]}</p>
          </Section>

          <Section title="隐藏文字">
            <Input value={g.text.content} onChange={(e) => patchGlance((x) => ({ ...x, text: { ...x.text, content: e.target.value } }))} aria-label="隐藏文字" />
            <SliderRow live="glance" label="字号" value={g.text.fontSize} min={3} max={25} step={0.5} onChange={(fontSize) => patchGlance((x) => ({ ...x, text: { ...x.text, fontSize } }))} format={(v) => `${v}%`} />
            <SliderRow live="glance" label="加粗" value={g.bold} min={0} max={0.08} step={0.005} onChange={(bold) => patchGlance((x) => ({ ...x, bold }))} format={(v) => `${(v * 100).toFixed(1)}%`} />
            <SliderRow live="glance" label="密度" value={g.layout.gapY} min={0.2} max={4} step={0.05} onChange={(gapY) => patchGlance((x) => ({ ...x, layout: { ...x.layout, gapY, gapX: gapY * 0.4 } }))} format={(v) => `${v.toFixed(2)}×`} />
          </Section>

          <Section title="预演盗用" description="在画布上模拟二次加工，确认水印会浮现；用放大镜看 1:1 细节。">
            <div className="flex flex-wrap gap-1.5">
              {QUICK_REVEALS.map((k) => (
                <button
                  key={k}
                  onClick={() => setReveal(reveal === k ? "none" : k)}
                  aria-pressed={reveal === k}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-xs outline-ring-primary",
                    reveal === k
                      ? "bg-foreground-intense text-background"
                      : "bg-background-muted text-foreground-strong hover:bg-background-strong"
                  )}
                >
                  {REVEAL_LABELS[k]}
                </button>
              ))}
            </div>
          </Section>

          <More id="glance-layers" label="触发层与细节">
            <Section description="每层对应一种盗用场景，振幅单位是 8-bit 灰阶；改动后场景变为“自定义”。">
              <SliderRow live="glance" label="旋转" value={g.layout.rotation} min={-90} max={90} onChange={(rotation) => patchGlance((x) => ({ ...x, layout: { ...x.layout, rotation } }))} format={(v) => `${v}°`} />
              <SliderRow live="glance" label="边缘羽化" value={g.feather} min={0} max={8} step={0.5} onChange={(feather) => set({ feather })} format={(v) => `${v}‰`} />
              <SliderRow live="glance" label="纹理自适应" value={g.adaptive} min={0} max={1} step={0.05} onChange={(adaptive) => set({ adaptive })} format={(v) => `${Math.round(v * 100)}%`} />
            </Section>
            <Section>
              <SwitchRow label="相位反转光栅" hint="重采样 / 打印加网 / 锐化 → 显形" checked={g.grating.enabled} onChange={(enabled) => set({ grating: { ...g.grating, enabled } })} />
              {g.grating.enabled && (
                <>
                  <SliderRow live="glance" label="振幅" value={g.grating.amplitude} min={0.5} max={12} step={0.5} onChange={(amplitude) => set({ grating: { ...g.grating, amplitude } })} />
                  <SliderRow live="glance" label="色度振幅" value={g.grating.chroma} min={0} max={24} step={1} onChange={(chroma) => set({ grating: { ...g.grating, chroma } })} />
                  <FieldRow label="载波">
                    <Segmented
                      size="sm"
                      value={g.grating.kind}
                      onChange={(kind) => set({ grating: { ...g.grating, kind } })}
                      options={[
                        { value: "checker", label: "棋盘" },
                        { value: "lines", label: "斜线" },
                      ]}
                    />
                  </FieldRow>
                  {g.grating.kind === "lines" && (
                    <>
                      <SliderRow live="glance" label="周期" value={g.grating.period} min={2} max={6} step={0.5} onChange={(period) => set({ grating: { ...g.grating, period } })} format={(v) => `${v}px`} />
                      <SliderRow live="glance" label="角度" value={g.grating.angle} min={0} max={180} onChange={(angle) => set({ grating: { ...g.grating, angle } })} format={(v) => `${v}°`} />
                    </>
                  )}
                </>
              )}
            </Section>
            <Section>
              <SwitchRow label="防复印底纹" hint="打印网点扩大 → 显形" checked={g.pantograph.enabled} onChange={(enabled) => set({ pantograph: { ...g.pantograph, enabled } })} />
              {g.pantograph.enabled && (
                <>
                  <SliderRow live="glance" label="振幅" value={g.pantograph.amplitude} min={0.5} max={12} step={0.5} onChange={(amplitude) => set({ pantograph: { ...g.pantograph, amplitude } })} />
                  <SliderRow live="glance" label="粗网周期" value={g.pantograph.coarsePeriod} min={3} max={10} onChange={(coarsePeriod) => set({ pantograph: { ...g.pantograph, coarsePeriod } })} format={(v) => `${v}px`} />
                </>
              )}
            </Section>
            <Section>
              <SwitchRow label="暗部色调偏移" hint="拉对比度 / 提亮阴影 → 显形" checked={g.tone.enabled} onChange={(enabled) => set({ tone: { ...g.tone, enabled } })} />
              {g.tone.enabled && (
                <>
                  <SliderRow live="glance" label="振幅" value={g.tone.amplitude} min={0.2} max={6} step={0.1} onChange={(amplitude) => set({ tone: { ...g.tone, amplitude } })} />
                  <SliderRow live="glance" label="暗部偏置" value={g.tone.shadowBias} min={0} max={1} step={0.05} onChange={(shadowBias) => set({ tone: { ...g.tone, shadowBias } })} format={(v) => `${Math.round(v * 100)}%`} />
                </>
              )}
            </Section>
            <Section>
              <SwitchRow label="等亮度色度偏移" hint="拉饱和度 / 平均法去色 → 显形" checked={g.chroma.enabled} onChange={(enabled) => set({ chroma: { ...g.chroma, enabled } })} />
              {g.chroma.enabled && (
                <>
                  <SliderRow live="glance" label="振幅" value={g.chroma.amplitude} min={0.5} max={16} step={0.5} onChange={(amplitude) => set({ chroma: { ...g.chroma, amplitude } })} />
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
            <p className="px-4 pb-2 text-xs leading-relaxed text-foreground-muted">
              高频层依赖逐像素结构，请以 PNG / 无损 WebP 导出。平台二次 JPEG 压缩会抹掉高频层，低频层与盲水印仍在。
            </p>
          </More>
        </>
      )}
    </div>
  )
}
