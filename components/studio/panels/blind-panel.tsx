"use client"

import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { NumberField } from "@appica/ui-react/number-field"
import { Switch } from "@appica/ui-react/switch"
import { Download, Loader2 } from "lucide-react"
import { useState } from "react"

import { TRUSTMARK_BASE } from "@/lib/config"
import { useStudio } from "@/lib/store"
import { DEFAULT_KEY } from "@/lib/watermark/blind/classic"
import { creatorIdFromText, dateFromDay, dayFromDate } from "@/lib/watermark/blind/payload"
import type { BlindConfig } from "@/lib/watermark/pipeline"
import { previewWorker } from "@/lib/workers/client"

import { Callout, FieldRow, Section, Segmented, SliderRow } from "../controls"

const ROBUSTNESS = [
  ["JPEG q50 / WebP", "✓", "✓"],
  ["缩放 25%–150%、截图", "✓", "✓"],
  ["亮度 / 对比度 / Gamma", "✓", "✓"],
  ["噪声、模糊", "✓", "✓"],
  ["裁剪 5%–15%", "✗", "✓"],
  ["首次加载", "0 KB", "≈64 MB"],
]

export function BlindPanel() {
  const { job, setJob, trustmarkReady, setTrustmarkReady } = useStudio()
  const keyStripped = useStudio((s) => !!s.templates.find((t) => t.id === s.activeTemplateId)?.privateKeyStripped)
  const b = job.blind
  const set = (p: Partial<BlindConfig>) => setJob((j) => ({ ...j, blind: { ...j.blind, ...p } }))
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const needsModel = b.engine !== "cdp"
  const customKey = b.key !== DEFAULT_KEY

  return (
    <div>
      <Section
        title="算法盲水印"
        description="肉眼不可见的版权指纹，可在“验证”页提取"
        action={<Switch checked={b.enabled} onCheckedChange={(enabled) => set({ enabled })} />}
      >
        <Segmented
          value={b.engine}
          onChange={(engine) => set({ engine })}
          options={[
            { value: "cdp", label: "频域 CDP", title: "零下载、即时" },
            { value: "trustmark", label: "TrustMark", title: "深度模型，抗裁剪" },
            { value: "dual", label: "双引擎", title: "两者叠加，互为备份" },
          ]}
        />
        {needsModel && !trustmarkReady && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-background-muted px-3 py-2">
            <p className="text-xs text-foreground-muted">
              需要加载 TrustMark 模型（≈64 MB，首次后浏览器缓存）。未加载前仅嵌入 CDP。
              {loadError && <span className="block text-error-emphasis">加载失败：{loadError}</span>}
            </p>
            <Button
              size="sm"
              variant="soft"
              disabled={loading}
              onClick={async () => {
                setLoading(true)
                setLoadError(null)
                try {
                  await previewWorker().loadTrustMark(new URL(TRUSTMARK_BASE, location.href).href)
                  setTrustmarkReady(true)
                } catch (e) {
                  setLoadError(e instanceof Error ? e.message : String(e))
                } finally {
                  setLoading(false)
                }
              }}
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              加载
            </Button>
          </div>
        )}
        <table className="w-full text-xs">
          <thead className="text-foreground-muted">
            <tr>
              <th className="py-1 text-left font-normal">实测鲁棒性</th>
              <th className="w-16 py-1 font-normal">CDP</th>
              <th className="w-20 py-1 font-normal">TrustMark</th>
            </tr>
          </thead>
          <tbody className="text-foreground-strong">
            {ROBUSTNESS.map(([k, a, c]) => (
              <tr key={k} className="border-t border-border-muted">
                <td className="py-1">{k}</td>
                <td className="py-1 text-center">{a}</td>
                <td className="py-1 text-center">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="载荷" description="56 bit 紧凑指纹 + CRC-16；完整信息写入本地注册表">
        <FieldRow label="创作者">
          <Input
            placeholder="名字或数字工号"
            value={b.creator}
            onChange={(e) => set({ creator: e.target.value })}
            endSlot={<span className="font-mono text-[11px] text-foreground-subtle">#{creatorIdFromText(b.creator || job.author || "anonymous").toString(16).padStart(6, "0")}</span>}
          />
        </FieldRow>
        <FieldRow label="日期">
          <span className="text-sm text-foreground-strong tabular-nums">
            {dateFromDay(dayFromDate(new Date())).toISOString().slice(0, 10)}
            <span className="ml-1.5 text-xs text-foreground-muted">按天精度写入</span>
          </span>
        </FieldRow>
        <FieldRow label="作品序号">
          <Segmented
            size="sm"
            value={b.serialMode}
            onChange={(serialMode) => set({ serialMode })}
            options={[
              { value: "hash", label: "原图哈希" },
              { value: "index", label: "批次序号" },
              { value: "manual", label: "手动" },
            ]}
          />
        </FieldRow>
        {b.serialMode === "manual" && (
          <FieldRow label="序号">
            <NumberField value={b.serial} min={0} max={16383} onValueChange={(v) => set({ serial: v ?? 0 })} />
          </FieldRow>
        )}
      </Section>

      <Section title="密钥与强度">
        <FieldRow label="密钥">
          <Segmented
            size="sm"
            value={customKey ? "private" : "public"}
            onChange={(v) => set({ key: v === "public" ? DEFAULT_KEY : "" })}
            options={[
              { value: "public", label: "公开验证" },
              { value: "private", label: "私有密钥" },
            ]}
          />
        </FieldRow>
        {customKey && (
          <FieldRow label="私钥">
            <Input type="password" placeholder="只有持有者能检出" value={b.key} onChange={(e) => set({ key: e.target.value })} />
          </FieldRow>
        )}
        {customKey && !b.key && (
          <Callout tone="warning">
            {keyStripped ? "该模板导出时已去除私钥，" : ""}尚未填写私钥：在填写之前按公开密钥嵌入，任何人都能检出。
          </Callout>
        )}
        <SliderRow label="CDP 强度" value={b.strength} min={3} max={9} step={0.5} onChange={(strength) => set({ strength })} />
        <Callout>
          强度 5 时实测 PSNR ≈ 39.5 dB，JPEG q50、缩放 25%、截图加边框均可检出。私有密钥仅影响 CDP；TrustMark
          的载荷任何持有模型的人都能解出，勿放敏感信息。
        </Callout>
      </Section>
    </div>
  )
}
