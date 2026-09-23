"use client"

import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { Progress } from "@appica/ui-react/progress"
import { downloadZip } from "client-zip"
import { Download, FolderDown, KeyRound, Loader2 } from "lucide-react"
import { useState } from "react"

import { IdentityDialog, IdentitySummary } from "@/components/identity/identity-dialog"
import { TRUSTMARK_BASE } from "@/lib/config"
import { useIdentity } from "@/lib/identity-store"
import { jobForAsset, processingJob, useStudio, type Asset } from "@/lib/store"
import { buildCertificateBody, signCertificate, SIGNATURE_DISCLAIMER, type Certificate } from "@/lib/watermark/certificate"
import { EXT } from "@/lib/watermark/codec"
import { signWithIdentity, type IdentityRecord } from "@/lib/watermark/identity"
import { lossyExportWarnings, type ExportConfig, type WatermarkJob } from "@/lib/watermark/pipeline"
import { writeITXt } from "@/lib/watermark/png-meta"
import { registry, sha256Hex } from "@/lib/watermark/registry"
import { hasPrivateKey } from "@/lib/watermark/templates"
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

/**
 * 收尾一张导出图：有签名身份且嵌入了盲水印时签发证书（可选写进 PNG iTXt），并登记到注册表。
 * outputSha256 取编码器输出的字节；证书写进 PNG 后文件会变，验证时去掉 veilmark:cert 块再算哈希。
 */
async function finalize(
  job: WatermarkJob,
  asset: Asset,
  r: ProcessResult,
  name: string,
  opts: { record: boolean; embed: boolean; signer: IdentityRecord | null }
): Promise<{ output: Blob; cert?: Blob }> {
  const payload = r.report.payload
  if (!payload || !r.report.payloadHex) return { output: r.blob }
  const sourceSha256 = await sha256Hex(await asset.file.arrayBuffer())
  let output = r.blob
  let cert: Certificate | undefined
  if (opts.signer) {
    const bytes = new Uint8Array(await r.blob.arrayBuffer())
    cert = await signCertificate(
      buildCertificateBody({
        payload,
        engines: r.report.engines ?? job.blind.engine,
        keyMode: hasPrivateKey(job) ? "private" : "public",
        creator: opts.signer,
        fileName: name,
        sourceSha256,
        outputSha256: await sha256Hex(bytes),
        width: r.width,
        height: r.height,
      }),
      (m) => signWithIdentity(opts.signer!, m)
    )
    if (opts.embed && job.export.format === "png") output = new Blob([writeITXt(bytes, JSON.stringify(cert)).slice()], { type: r.blob.type })
  }
  if (opts.record)
    await registry.put({
      payloadHex: r.report.payloadHex,
      payload,
      creatorName: cert?.creator.name || job.blind.creator || job.author || "anonymous",
      fileName: asset.name,
      sourceSha256,
      createdAt: new Date().toISOString(),
      engines: r.report.engines ?? "",
      keyHint: hasPrivateKey(job) ? "private" : "public",
      ...(cert ? { certificate: cert } : {}),
    })
  return { output, cert: cert && new Blob([JSON.stringify(cert, null, 2) + "\n"], { type: "application/json" }) }
}

const certName = (name: string) => `${name.replace(/\.[^.]+$/, "")}.cert.json`

export function ExportPanel({ activeAsset }: { activeAsset?: Asset }) {
  const { job, setJob, assets, trustmarkReady, templates, activeTemplateId } = useStudio()
  const identity = useIdentity((s) => s.identity)
  const identityCreatorId = useIdentity((s) => s.creatorId)
  const e = job.export
  const set = (p: Partial<ExportConfig>) => setJob((j) => ({ ...j, export: { ...j.export, ...p } }))
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [autoRecord, setAutoRecord] = useState(true)
  const [sidecar, setSidecar] = useState(false)
  const [embed, setEmbed] = useState(true)
  const [identityOpen, setIdentityOpen] = useState(false)
  const [failures, setFailures] = useState<string[]>([])
  const warnings = lossyExportWarnings(job)
  const selected = assets.filter((a) => a.selected)

  /** 每张图用它自己的模板（未指定则跟随当前参数），再按与预览相同的规则处理（TrustMark 降级、身份派生创作者 ID） */
  const effectiveJob = (asset: Asset): WatermarkJob =>
    processingJob(jobForAsset({ job, templates, activeTemplateId }, asset), { trustmarkReady, identityCreatorId })

  async function exportCurrent() {
    if (!activeAsset?.result) return
    const j = effectiveJob(activeAsset)
    const index = assets.findIndex((a) => a.id === activeAsset.id)
    const name = outputName(j, activeAsset, index)
    const signer = await useIdentity.getState().signer()
    const { output, cert } = await finalize(j, activeAsset, activeAsset.result, name, { record: autoRecord, embed, signer })
    saveBlob(output, name)
    if (cert && sidecar) saveBlob(cert, certName(name))
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
    const signer = await useIdentity.getState().signer()
    const files: Array<{ name: string; input: Blob }> = []
    const errs: string[] = []
    let images = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const asset = selected[i]
      if (!r.ok) {
        errs.push(`${asset.name}：${r.error}`)
        continue
      }
      const j = jobs.get(asset.id)!
      const name = outputName(j, asset, assets.indexOf(asset))
      const { output, cert } = await finalize(j, asset, r.value, name, { record: autoRecord, embed, signer })
      files.push({ name, input: output })
      // ZIP 里每张图都附一份证书（与是否内嵌无关：.cert.json 对任何格式都适用）
      if (cert) files.push({ name: certName(name), input: cert })
      images++
    }
    setFailures(errs)
    if (images === 1 && files.length === 1) saveBlob(files[0].input, files[0].name)
    else if (files.length) saveBlob(await downloadZip(files).blob(), `veilmark_${new Date().toISOString().slice(0, 10)}.zip`)
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

      <Section
        title="签名与证书"
        description="导出时用你的签名身份签发版权证书，可离线验证"
        action={
          <Button size="sm" variant="ghost" onClick={() => setIdentityOpen(true)}>
            {identity ? "管理" : "创建"}
          </Button>
        }
      >
        {identity ? (
          <IdentitySummary />
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-background-muted px-3 py-2.5">
            <p className="text-xs leading-relaxed text-foreground-muted">尚未创建签名身份：导出仍可进行，但不会签发证书。</p>
            <Button size="sm" variant="soft" onClick={() => setIdentityOpen(true)}>
              <KeyRound className="size-3.5" /> 创建
            </Button>
          </div>
        )}
        {identity && (
          <>
            <SwitchRow
              label="PNG 内嵌证书"
              hint={e.format === "png" ? "写入 iTXt 块 veilmark:cert，像素与盲水印不受影响" : "仅 PNG 支持；WebP 的 XMP 写入见路线图"}
              checked={embed && e.format === "png"}
              onChange={setEmbed}
            />
            <SwitchRow label="单张导出时附带 .cert.json" hint="批量 ZIP 总是附带每张图的证书" checked={sidecar} onChange={setSidecar} />
          </>
        )}
        {!job.blind.enabled && <Callout tone="warning">证书靠图中的盲水印指纹与图片绑定，请先开启盲水印。</Callout>}
        <p className="text-[11px] leading-relaxed text-foreground-subtle">{SIGNATURE_DISCLAIMER}</p>
      </Section>

      <Section title="导出">
        <SwitchRow label="写入本地注册表" hint="保存指纹 ↔ 证书/原图哈希，供日后验证举证" checked={autoRecord} onChange={setAutoRecord} />
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
      <IdentityDialog open={identityOpen} onClose={() => setIdentityOpen(false)} />
    </div>
  )
}
