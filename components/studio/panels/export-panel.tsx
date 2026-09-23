"use client"

import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { useState } from "react"

import { IdentityDialog, IdentitySummary } from "@/components/identity/identity-dialog"
import { useIdentity } from "@/lib/identity-store"
import { useStudio, type Asset } from "@/lib/store"
import { SIGNATURE_DISCLAIMER } from "@/lib/watermark/certificate"
import { lossyExportWarnings, type ExportConfig } from "@/lib/watermark/pipeline"

import { Callout, More, Section, Segmented, SliderRow, SwitchRow } from "../controls"
import { outputName, useExportPrefs } from "../export-bar"

/** 导出设置；导出按钮在检查器底部常驻的导出栏里 */
export function ExportPanel({ activeAsset }: { activeAsset?: Asset }) {
  const { job, setJob } = useStudio()
  const identity = useIdentity((s) => s.identity)
  const prefs = useExportPrefs()
  const e = job.export
  const set = (p: Partial<ExportConfig>) => setJob((j) => ({ ...j, export: { ...j.export, ...p } }))
  const [identityOpen, setIdentityOpen] = useState(false)
  const warnings = lossyExportWarnings(job)

  return (
    <div>
      <Section title="格式">
        <Segmented
          value={e.format}
          onChange={(format) => set({ format })}
          options={[
            { value: "png", label: "PNG" },
            { value: "webp-lossless", label: "无损 WebP" },
            { value: "webp", label: "WebP" },
            { value: "jpeg", label: "JPEG" },
          ]}
        />
        {(e.format === "webp" || e.format === "jpeg") && (
          <SliderRow label="质量" value={e.quality} min={0.6} max={1} step={0.01} onChange={(quality) => set({ quality })} format={(v) => `${Math.round(v * 100)}`} />
        )}
        {warnings.map((w) => (
          <Callout key={w} tone="warning">
            {w}
          </Callout>
        ))}
      </Section>

      <Section
        title="签名证书"
        description="导出时自动签发，任何人都能离线验证"
        action={
          identity && (
            <Button size="sm" variant="ghost" onClick={() => setIdentityOpen(true)}>
              高级
            </Button>
          )
        }
      >
        <IdentitySummary />
        {identity && !job.blind.enabled && <Callout tone="warning">证书靠盲水印指纹与图片绑定，开启盲水印后才会签发。</Callout>}
      </Section>

      <More id="export-more" label="文件名与登记">
        <Section>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-foreground-muted">文件名 · 支持 {"{filename} {index} {author} {date}"}</span>
            <Input value={e.filename} onChange={(ev) => set({ filename: ev.target.value })} />
          </label>
          {activeAsset && <p className="truncate font-mono text-[11px] text-foreground-muted">→ {outputName(job, activeAsset, 0)}</p>}
          <SwitchRow
            label="写入本地注册表"
            hint="保存指纹与证书、原图哈希，供日后在“验证”页举证"
            checked={prefs.autoRecord}
            onChange={(autoRecord) => prefs.set({ autoRecord })}
          />
          {identity && (
            <>
              <SwitchRow
                label="PNG 内嵌证书"
                hint={e.format === "png" ? "写入 iTXt 块，像素与盲水印不受影响" : "仅 PNG 支持"}
                checked={prefs.embed && e.format === "png"}
                onChange={(embed) => prefs.set({ embed })}
              />
              <SwitchRow
                label="单张导出附带 .cert.json"
                hint="批量导出的 ZIP 总是附带"
                checked={prefs.sidecar}
                onChange={(sidecar) => prefs.set({ sidecar })}
              />
            </>
          )}
          <p className="text-[11px] leading-relaxed text-foreground-subtle">{SIGNATURE_DISCLAIMER}</p>
        </Section>
      </More>
      <IdentityDialog open={identityOpen} onClose={() => setIdentityOpen(false)} />
    </div>
  )
}
