"use client"

import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { Progress } from "@appica/ui-react/progress"
import { downloadZip } from "client-zip"
import { Download, FolderDown, Loader2 } from "lucide-react"
import { useState } from "react"

import { TRUSTMARK_BASE } from "@/lib/config"
import { jobForAsset, useStudio, type Asset } from "@/lib/store"
import { EXT } from "@/lib/watermark/codec"
import { lossyExportWarnings, type ExportConfig, type WatermarkJob } from "@/lib/watermark/pipeline"
import { registry, sha256Hex } from "@/lib/watermark/registry"
import { resolveTemplate } from "@/lib/watermark/visible/layout"
import { runPool } from "@/lib/workers/client"
import type { ProcessResult } from "@/lib/workers/watermark.worker"

import { Callout, Section, Segmented, SliderRow, SwitchRow } from "../controls"

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

export function outputName(job: WatermarkJob, asset: Asset, index: number) {
  const base = resolveTemplate(job.export.filename || "{filename}_wm", { filename: asset.name, index, author: job.author })
  return `${base.replace(/[\\/:*?"<>|]/g, "_")}.${EXT[job.export.format]}`
}

async function record(job: WatermarkJob, asset: Asset, r: ProcessResult) {
  if (!r.report.payload || !r.report.payloadHex) return
  await registry.put({
    payloadHex: r.report.payloadHex,
    payload: r.report.payload,
    creatorName: job.blind.creator || job.author || "anonymous",
    fileName: asset.name,
    sourceSha256: await sha256Hex(await asset.file.arrayBuffer()),
    createdAt: new Date().toISOString(),
    engines: r.report.engines ?? "",
    keyHint: job.blind.key === "" ? "private" : job.blind.key.startsWith("veilmark-public") ? "public" : "private",
  })
}

export function ExportPanel({ activeAsset }: { activeAsset?: Asset }) {
  const { job, setJob, assets, trustmarkReady, templates, activeTemplateId } = useStudio()
  const e = job.export
  const set = (p: Partial<ExportConfig>) => setJob((j) => ({ ...j, export: { ...j.export, ...p } }))
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [autoRecord, setAutoRecord] = useState(true)
  const [failures, setFailures] = useState<string[]>([])
  const warnings = lossyExportWarnings(job)
  const selected = assets.filter((a) => a.selected)

  /** 每张图用它自己的模板（未指定则跟随当前参数）；TrustMark 未加载时降级为 CDP，与预览一致 */
  const effectiveJob = (asset: Asset): WatermarkJob => {
    const j = jobForAsset({ job, templates, activeTemplateId }, asset)
    return j.blind.engine !== "cdp" && !trustmarkReady ? { ...j, blind: { ...j.blind, engine: "cdp" } } : j
  }

  async function exportCurrent() {
    if (!activeAsset?.result) return
    const j = effectiveJob(activeAsset)
    const index = assets.findIndex((a) => a.id === activeAsset.id)
    saveBlob(activeAsset.result.blob, outputName(j, activeAsset, index))
    if (autoRecord) await record(j, activeAsset, activeAsset.result)
  }

  async function exportBatch() {
    const jobs = new Map(selected.map((a) => [a.id, effectiveJob(a)]))
    setFailures([])
    setProgress({ done: 0, total: selected.length })
    const needsTrustMark = [...jobs.values()].some((j) => j.blind.enabled && j.blind.engine !== "cdp")
    const results = await runPool(
      selected,
      (w, asset) => {
        const j = jobs.get(asset.id)!
        return w.process(asset.file, j, { author: j.author, filename: asset.name, index: assets.indexOf(asset), date: new Date() })
      },
      (done, total) => setProgress({ done, total }),
      async (w) => {
        // 图片水印位图由 Worker 按需解码；模型需要每个池内 Worker 各自加载
        if (needsTrustMark) await w.loadTrustMark(new URL(TRUSTMARK_BASE, location.href).href)
      }
    )
    const files: Array<{ name: string; input: Blob }> = []
    const errs: string[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const asset = selected[i]
      if (!r.ok) {
        errs.push(`${asset.name}：${r.error}`)
        continue
      }
      const j = jobs.get(asset.id)!
      files.push({ name: outputName(j, asset, assets.indexOf(asset)), input: r.value.blob })
      if (autoRecord) await record(j, asset, r.value)
    }
    setFailures(errs)
    if (files.length === 1) saveBlob(files[0].input, files[0].name)
    else if (files.length > 1) saveBlob(await downloadZip(files).blob(), `veilmark_${new Date().toISOString().slice(0, 10)}.zip`)
    setProgress(null)
  }

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

      <Section title="命名" description="支持 {filename} {index} {author} {date} 等变量">
        <Input value={e.filename} onChange={(ev) => set({ filename: ev.target.value })} />
        {activeAsset && <p className="font-mono text-[11px] text-foreground-muted">预览：{outputName(job, activeAsset, 0)}</p>}
      </Section>

      <Section title="导出">
        <SwitchRow label="写入本地注册表" hint="保存指纹 ↔ 创作者/原图哈希，供日后验证举证" checked={autoRecord} onChange={setAutoRecord} />
        <div className="flex flex-col gap-2">
          <Button variant="primary" disabled={!activeAsset?.result} onClick={exportCurrent}>
            <Download className="size-4" /> 导出当前图片
          </Button>
          <Button variant="outline" disabled={!selected.length || !!progress} onClick={exportBatch}>
            {progress ? <Loader2 className="size-4 animate-spin" /> : <FolderDown className="size-4" />}
            批量处理并导出已选 {selected.length} 张
          </Button>
        </div>
        {progress && (
          <div className="flex flex-col gap-1">
            <Progress value={(progress.done / progress.total) * 100} />
            <span className="text-xs text-foreground-muted tabular-nums">
              {progress.done}/{progress.total}
            </span>
          </div>
        )}
        {failures.length > 0 && (
          <Callout tone="warning">
            {failures.length} 张处理失败：
            {failures.map((f) => (
              <span key={f} className="block">
                {f}
              </span>
            ))}
          </Callout>
        )}
      </Section>
    </div>
  )
}
