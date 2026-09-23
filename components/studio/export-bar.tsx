"use client"

import { Button } from "@appica/ui-react/button"
import { Progress } from "@appica/ui-react/progress"
import { downloadZip } from "client-zip"
import { Download, FolderDown, Loader2, X } from "lucide-react"
import { useState } from "react"
import { create } from "zustand"

import { TRUSTMARK_BASE } from "@/lib/config"
import { useIdentity } from "@/lib/identity-store"
import { jobForAsset, processingJob, useStudio, type Asset } from "@/lib/store"
import { buildCertificateBody, signCertificate, type Certificate } from "@/lib/watermark/certificate"
import { EXT } from "@/lib/watermark/codec"
import { certificateCreator, signWithIdentity, type IdentityRecord } from "@/lib/watermark/identity"
import type { WatermarkJob } from "@/lib/watermark/pipeline"
import { writeITXt } from "@/lib/watermark/png-meta"
import { registry, sha256Hex } from "@/lib/watermark/registry"
import { hasPrivateKey } from "@/lib/watermark/templates"
import { resolveTemplate } from "@/lib/watermark/visible/layout"
import { runPool } from "@/lib/workers/client"
import type { ProcessResult } from "@/lib/workers/watermark.worker"

/** 导出选项（导出设置面板里改，底部导出栏里用） */
export const useExportPrefs = create<{
  autoRecord: boolean
  sidecar: boolean
  embed: boolean
  set(p: Partial<{ autoRecord: boolean; sidecar: boolean; embed: boolean }>): void
}>((set) => ({ autoRecord: true, sidecar: false, embed: true, set: (p) => set(p) }))

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/**
 * 触屏设备上单张导出走系统分享面板（iPhone/iPad 可直接“存储图像”到相册或“存储到文件”），
 * 不支持或被拒绝（例如处理耗时过长、用户手势已失效）时退回普通下载。
 */
async function deliver(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type })
  const touch = matchMedia("(pointer: coarse)").matches
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return
    }
  }
  saveBlob(blob, name)
}

export function outputName(job: WatermarkJob, asset: Asset, index: number) {
  const base = resolveTemplate(job.export.filename || "{filename}_wm", { filename: asset.name, index, author: job.author })
  return `${base.replace(/[\\/:*?"<>|]/g, "_")}.${EXT[job.export.format]}`
}

/**
 * 收尾一张导出图：嵌入了盲水印时用本机签名身份签发证书（可选写进 PNG iTXt），并登记到注册表。
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
        creator: certificateCreator(opts.signer, job.author),
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

/** 检查器底部常驻的导出栏：任何标签页下都能一键导出，手机上正好在拇指区 */
export function ExportBar({ activeAsset }: { activeAsset?: Asset }) {
  const { job, assets, trustmarkReady, templates, activeTemplateId } = useStudio()
  const identityCreatorId = useIdentity((s) => s.creatorId)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [failures, setFailures] = useState<string[]>([])
  const selected = assets.filter((a) => a.selected)

  /** 每张图用它自己的模板（未指定则跟随当前参数），再按与预览相同的规则处理（TrustMark 降级、身份派生创作者 ID） */
  const effectiveJob = (asset: Asset): WatermarkJob =>
    processingJob(jobForAsset({ job, templates, activeTemplateId }, asset), { trustmarkReady, identityCreatorId })

  async function exportCurrent() {
    if (!activeAsset?.result) return
    const { autoRecord, embed, sidecar } = useExportPrefs.getState()
    setSaving(true)
    setFailures([])
    try {
      const j = effectiveJob(activeAsset)
      const index = assets.findIndex((a) => a.id === activeAsset.id)
      const name = outputName(j, activeAsset, index)
      const signer = await useIdentity.getState().signer()
      const { output, cert } = await finalize(j, activeAsset, activeAsset.result, name, { record: autoRecord, embed, signer })
      await deliver(output, name)
      if (cert && sidecar) saveBlob(cert, certName(name))
    } catch (e) {
      setFailures([`${activeAsset.name}：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setSaving(false)
    }
  }

  async function exportBatch() {
    const { autoRecord, embed } = useExportPrefs.getState()
    const jobs = new Map(selected.map((a) => [a.id, effectiveJob(a)]))
    setFailures([])
    setProgress({ done: 0, total: selected.length })
    try {
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
    } catch (e) {
      setFailures([e instanceof Error ? e.message : String(e)])
    } finally {
      setProgress(null)
    }
  }

  const batch = assets.length > 1

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] short:pt-2 short:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {failures.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-xs leading-relaxed text-foreground-strong">
          <div className="max-h-24 min-w-0 flex-1 overflow-y-auto">
            {failures.length > 1 && <span className="block font-medium">{failures.length} 张处理失败</span>}
            {failures.map((f) => (
              <span key={f} className="block break-all">
                {f}
              </span>
            ))}
          </div>
          <button aria-label="关闭" className="shrink-0 text-foreground-muted hover:text-foreground-intense" onClick={() => setFailures([])}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {progress ? (
        <div className="flex h-9 items-center gap-3">
          <Progress value={(progress.done / progress.total) * 100} className="flex-1" />
          <span className="shrink-0 text-xs text-foreground-muted tabular-nums">
            处理中 {progress.done}/{progress.total}
          </span>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" disabled={!activeAsset?.result || saving} onClick={exportCurrent}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {batch ? "导出当前" : "导出图片"}
          </Button>
          {batch && (
            <Button variant="outline" className="flex-1" disabled={!selected.length} onClick={exportBatch}>
              <FolderDown className="size-4" />
              批量导出 {selected.length} 张
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
