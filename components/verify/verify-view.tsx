"use client"

import { Badge } from "@appica/ui-react/badge"
import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { Switch } from "@appica/ui-react/switch"
import { FileSearch, Loader2, Upload } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { AppHeader } from "@/components/app-header"
import { TRUSTMARK_BASE } from "@/lib/config"
import { dateFromDay } from "@/lib/watermark/blind/payload"
import { registry, type RegistryRecord } from "@/lib/watermark/registry"
import type { VerifyHit } from "@/lib/watermark/verify"
import { previewWorker } from "@/lib/workers/client"

export function VerifyView() {
  const [file, setFile] = useState<{ url: string; name: string } | null>(null)
  const [hits, setHits] = useState<Array<VerifyHit & { record?: RegistryRecord }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateKey, setPrivateKey] = useState("")
  const [useTrustMark, setUseTrustMark] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [records, setRecords] = useState<RegistryRecord[]>([])
  const input = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => registry.list().then(setRecords), [])
  useEffect(() => {
    refresh()
  }, [refresh])

  async function check(f: File) {
    setFile((old) => {
      if (old) URL.revokeObjectURL(old.url)
      return { url: URL.createObjectURL(f), name: f.name }
    })
    setBusy(true)
    setHits(null)
    setError(null)
    try {
      const res = await previewWorker().verify(
        f,
        privateKey ? [privateKey] : [],
        useTrustMark ? new URL(TRUSTMARK_BASE, location.href).href : undefined
      )
      setHits(await Promise.all(res.map(async (h) => ({ ...h, record: h.payloadHex ? await registry.get(h.payloadHex) : undefined }))))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = e.clipboardData?.files?.[0]
      if (f) check(f)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  })

  const found = hits?.find((h) => h.found)

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-6 py-8 lg:grid-cols-[1fr_1.1fr]">
        <section className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground-intense">验证隐性水印</h1>
            <p className="mt-1 text-sm text-foreground-muted">上传或粘贴疑似盗用的图片（截图、压缩、缩放过都可以），在本地提取版权指纹。</p>
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (f) check(f)
            }}
            onClick={() => input.current?.click()}
            className="checkerboard relative grid aspect-[4/3] cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-border-strong"
          >
            {file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.url} alt={file.name} className="absolute inset-0 size-full object-contain" />
            ) : (
              <span className="flex flex-col items-center gap-2 text-sm text-foreground-muted">
                <Upload className="size-5" /> 拖拽 / 粘贴 / 点击选择图片
              </span>
            )}
            {busy && (
              <span className="absolute inset-0 grid place-items-center bg-background/70">
                <Loader2 className="size-5 animate-spin" />
              </span>
            )}
          </div>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
          <div className="grid gap-3 rounded-xl border border-border p-4">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                同时用 TrustMark 检测
                <span className="block text-xs text-foreground-muted">抗裁剪更强，需下载 ≈47 MB 解码模型</span>
              </span>
              <Switch checked={useTrustMark} onCheckedChange={setUseTrustMark} />
            </label>
            <Input type="password" placeholder="私有密钥（可选，仅 CDP）" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div className="rounded-xl border border-border p-5">
            <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-intense">
              <FileSearch className="size-4" /> 检测结果
            </h2>
            {!hits && !busy && !error && <p className="mt-3 text-sm text-foreground-muted">等待图片…</p>}
            {error && <p className="mt-3 text-sm text-error-emphasis">{error}</p>}
            {hits && (
              <div className="mt-4 flex flex-col gap-4">
                <div className={found ? "rounded-lg bg-success-subtle p-4" : "rounded-lg bg-background-muted p-4"}>
                  <p className="text-base font-semibold text-foreground-intense">{found ? "检测到版权水印" : "未检测到可识别的水印"}</p>
                  {found?.payload && (
                    <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
                      <dt className="text-foreground-muted">指纹</dt>
                      <dd className="font-mono">{found.payloadHex}</dd>
                      <dt className="text-foreground-muted">创作者 ID</dt>
                      <dd className="font-mono">#{found.payload.creator.toString(16).padStart(6, "0")}</dd>
                      <dt className="text-foreground-muted">登记日期</dt>
                      <dd>{dateFromDay(found.payload.day).toISOString().slice(0, 10)}</dd>
                      <dt className="text-foreground-muted">作品序号</dt>
                      <dd className="font-mono">{found.payload.serial}</dd>
                      {found.record && (
                        <>
                          <dt className="text-foreground-muted">注册表</dt>
                          <dd>
                            {found.record.creatorName} · {found.record.fileName}
                          </dd>
                          <dt className="text-foreground-muted">原图 SHA-256</dt>
                          <dd className="truncate font-mono text-xs">{found.record.sourceSha256}</dd>
                        </>
                      )}
                    </dl>
                  )}
                  {found && !found.record && <p className="mt-2 text-xs text-foreground-muted">本机注册表中无此指纹；可导入创作者提供的注册表 JSON 比对。</p>}
                </div>
                <ul className="flex flex-col gap-2">
                  {hits.map((h, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 text-xs">
                      <span className="flex items-center gap-2">
                        <Badge size="sm" variant={h.found ? "success" : "soft"}>
                          {h.engine === "cdp" ? `CDP${h.key?.startsWith("veilmark-public") ? " · 公开密钥" : " · 私有密钥"}` : "TrustMark"}
                        </Badge>
                        <span className="text-foreground-muted">{h.detail}</span>
                      </span>
                      <span className="tabular-nums text-foreground-strong">{Math.round(h.confidence * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground-intense">本地注册表 · {records.length} 条</h2>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => importInput.current?.click()}>
                  导入
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!records.length}
                  onClick={async () => {
                    const a = document.createElement("a")
                    a.href = URL.createObjectURL(await registry.exportJSON())
                    a.download = "veilmark-registry.json"
                    a.click()
                  }}
                >
                  导出
                </Button>
              </div>
              <input
                ref={importInput}
                type="file"
                accept="application/json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) await registry.importJSON(f)
                  refresh()
                }}
              />
            </div>
            <ul className="mt-3 flex max-h-72 flex-col divide-y divide-border-muted overflow-auto text-xs">
              {records.map((r) => (
                <li key={r.payloadHex} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 py-2">
                  <span className="font-mono">{r.payloadHex}</span>
                  <span className="truncate text-foreground-strong">
                    {r.creatorName} · {r.fileName}
                  </span>
                  <span className="text-foreground-muted">{r.createdAt.slice(0, 10)}</span>
                </li>
              ))}
              {!records.length && <li className="py-2 text-foreground-muted">导出带盲水印的图片时会自动登记。</li>}
            </ul>
          </div>
        </section>
      </main>
    </div>
  )
}
