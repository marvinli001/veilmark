"use client"

import { Badge } from "@appica/ui-react/badge"
import { Button } from "@appica/ui-react/button"
import { Input } from "@appica/ui-react/input"
import { Switch } from "@appica/ui-react/switch"
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  FileBadge,
  FileSearch,
  FileText,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { AppHeader } from "@/components/app-header"
import { useIdentity } from "@/lib/identity-store"
import { cn } from "@/lib/utils"
import { TRUSTMARK_BASE } from "@/lib/config"
import { dateFromDay } from "@/lib/watermark/blind/payload"
import {
  checkCertificate,
  SIGNATURE_DISCLAIMER,
  type CertificateReport,
  type CheckStatus,
} from "@/lib/watermark/certificate"
import { sha256Hex } from "@/lib/watermark/core/bytes"
import { formatKeyId } from "@/lib/watermark/identity"
import { canonicalFileBytes, readITXt } from "@/lib/watermark/png-meta"
import { registry, type RegistryRecord } from "@/lib/watermark/registry"
import { fingerprintFromHits, type VerifyHit } from "@/lib/watermark/verify"
import { previewWorker } from "@/lib/workers/client"

interface ImageInput {
  file: File
  url: string
  sha256: string
  width: number
  height: number
  /** PNG iTXt 里内嵌的证书原文 */
  embedded: string | null
}

const STATUS_ICON: Record<CheckStatus, { Icon: typeof CircleCheck; cls: string; label: string }> = {
  pass: { Icon: CircleCheck, cls: "text-success-emphasis", label: "通过" },
  fail: { Icon: CircleX, cls: "text-error-emphasis", label: "失败" },
  warn: { Icon: CircleAlert, cls: "text-warning-emphasis", label: "需人工确认" },
  skip: { Icon: CircleMinus, cls: "text-foreground-subtle", label: "未检查" },
}

const isJson = (f: File) => f.type === "application/json" || /\.json$/i.test(f.name)

function saveText(text: string, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text // 交给 checkCertificate 报“结构不完整”
  }
}

export function VerifyView() {
  const [image, setImage] = useState<ImageInput | null>(null)
  const [certFile, setCertFile] = useState<{ name: string; text: string } | null>(null)
  const [source, setSource] = useState<{ name: string; sha256: string } | null>(null)
  const [hits, setHits] = useState<Array<VerifyHit & { record?: RegistryRecord }> | null>(null)
  const [report, setReport] = useState<CertificateReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateKey, setPrivateKey] = useState("")
  const [useTrustMark, setUseTrustMark] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [records, setRecords] = useState<RegistryRecord[]>([])
  const trusted = useIdentity((s) => s.trusted)
  const input = useRef<HTMLInputElement>(null)
  const sourceInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => registry.list().then(setRecords), [])
  useEffect(() => {
    refresh()
    useIdentity.getState().load()
  }, [refresh])

  async function loadImage(f: File) {
    setBusy(true)
    setHits(null)
    setError(null)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const bmp = await createImageBitmap(f)
      const next: ImageInput = {
        file: f,
        url: URL.createObjectURL(f),
        // PNG 内嵌证书后字节会变，按去掉证书块后的字节比对 outputSha256
        sha256: await sha256Hex(canonicalFileBytes(bytes)),
        width: bmp.width,
        height: bmp.height,
        embedded: await readITXt(bytes),
      }
      bmp.close()
      setImage((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return next
      })
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

  async function onFiles(files: File[]) {
    for (const f of files) {
      if (isJson(f)) setCertFile({ name: f.name, text: await f.text() })
      else if (f.type.startsWith("image/")) await loadImage(f)
    }
  }

  // 证书核验：图片、证书、原图、信任列表任一变化都重算（全部在本地完成）
  useEffect(() => {
    let cancelled = false
    async function run() {
      const primary = certFile?.text ?? image?.embedded
      if (!primary) return setReport(null)
      const cert = parseJson(primary)
      const payloadHex = (cert as { payloadHex?: string } | undefined)?.payloadHex
      const keyId = (cert as { creator?: { keyId?: string } } | undefined)?.creator?.keyId
      // 参考副本：图片内嵌 vs 旁路文件、本地注册表里的原件，用于定位被改动的字段
      const references: Array<{ label: string; cert: unknown }> = []
      if (certFile && image?.embedded && certFile.text !== image.embedded)
        references.push({ label: "图片内嵌证书", cert: parseJson(image.embedded) })
      const rec = payloadHex ? await registry.get(payloadHex) : undefined
      if (rec?.certificate) references.push({ label: "本地注册表", cert: rec.certificate })
      const t = keyId ? trusted.find((k) => k.keyId === keyId) : undefined
      const r = await checkCertificate({
        cert,
        image:
          image && hits
            ? { sha256: image.sha256, width: image.width, height: image.height, extracted: fingerprintFromHits(hits, payloadHex) }
            : undefined,
        sourceSha256: source?.sha256,
        trusted: t ? { publicKey: t.publicKey, label: t.label } : null,
        references,
        privateKeyProvided: !!privateKey,
      })
      if (!cancelled) setReport(r)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [certFile, image, hits, source, trusted, privateKey])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) onFiles(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  })

  const found = hits?.find((h) => h.found)
  const cert = report?.cert
  const certTrusted = cert && trusted.some((k) => k.keyId === cert.creator.keyId && k.publicKey === cert.creator.publicKey)

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_1.1fr]">
        <section className="flex min-w-0 flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground-intense">验证水印与版权证书</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              拖入疑似盗用的图片、<span className="font-mono">.cert.json</span> 证书，或两者一起。全部在本机核验，不联网。
            </p>
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              onFiles(Array.from(e.dataTransfer.files))
            }}
            onClick={() => input.current?.click()}
            className="checkerboard relative grid aspect-[4/3] cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-border-strong"
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.url} alt={image.file.name} className="absolute inset-0 size-full object-contain" />
            ) : (
              <span className="flex flex-col items-center gap-2 px-6 text-center text-sm text-foreground-muted">
                <Upload className="size-5" /> 拖拽 / 粘贴 / 点击选择图片或证书
              </span>
            )}
            {busy && (
              <span className="absolute inset-0 grid place-items-center bg-background/70">
                <Loader2 className="size-5 animate-spin" />
              </span>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*,application/json,.json"
            multiple
            hidden
            onChange={(e) => {
              onFiles(Array.from(e.target.files ?? []))
              e.target.value = ""
            }}
          />

          <div className="flex flex-wrap gap-2 text-xs">
            {image && (
              <Badge variant="soft" size="sm">
                <FileSearch className="size-3" /> {image.file.name} · {image.width}×{image.height}
              </Badge>
            )}
            {image?.embedded && (
              <Badge variant="info" size="sm">
                <FileBadge className="size-3" /> 图片内嵌证书
              </Badge>
            )}
            {certFile && (
              <Badge variant="info" size="sm">
                <FileText className="size-3" /> {certFile.name}
                <button aria-label="移除证书文件" onClick={() => setCertFile(null)} className="ml-0.5 hover:text-foreground-intense">
                  <X className="size-3" />
                </button>
              </Badge>
            )}
          </div>

          <div className="grid gap-3 rounded-xl border border-border p-4">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                同时用 TrustMark 检测
                <span className="block text-xs text-foreground-muted">抗裁剪更强，需加载 ≈47 MB 解码模型（本站静态资源）</span>
              </span>
              <Switch checked={useTrustMark} onCheckedChange={setUseTrustMark} />
            </label>
            <Input type="password" placeholder="私有密钥（可选，仅 CDP）" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
            {image && (
              <p className="text-xs text-foreground-muted">改了上面两项后，重新拖入图片即可按新设置检测。</p>
            )}
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                原图（可选）
                <span className="block truncate text-xs text-foreground-muted">
                  {source ? `${source.name} · ${source.sha256.slice(0, 16)}…` : "与证书登记的原图哈希比对，用于举证“我有原图”"}
                </span>
              </span>
              {source ? (
                <Button size="sm" variant="ghost" onClick={() => setSource(null)}>
                  移除
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => sourceInput.current?.click()}>
                  选择
                </Button>
              )}
              <input
                ref={sourceInput}
                type="file"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (f) setSource({ name: f.name, sha256: await sha256Hex(await f.arrayBuffer()) })
                }}
              />
            </div>
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-4">
          <div className="rounded-xl border border-border p-5">
            <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-intense">
              <ShieldCheck className="size-4" /> 版权证书核验
            </h2>
            {!report && (
              <p className="mt-3 text-sm text-foreground-muted">
                {image ? "这张图没有内嵌证书；可以再拖入对应的 .cert.json。" : "等待图片或证书…"}
              </p>
            )}
            {report && (
              <div className="mt-4 flex flex-col gap-4">
                <div className={cn("rounded-lg p-4", report.ok ? "bg-success-subtle" : "bg-error-subtle")}>
                  <p className="text-base font-semibold text-foreground-intense">
                    {report.ok
                      ? report.items.some((i) => i.status === "warn")
                        ? "证书有效，有项目需要人工确认"
                        : "证书有效，全部核对通过"
                      : "核验未通过"}
                  </p>
                  {cert && (
                    <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5 text-sm">
                      <dt className="text-foreground-muted">创作者</dt>
                      <dd className="min-w-0 truncate">{cert.creator.name || "（未署名）"}</dd>
                      <dt className="text-foreground-muted">keyId</dt>
                      <dd className="font-mono">{formatKeyId(cert.creator.keyId)}</dd>
                      <dt className="text-foreground-muted">指纹</dt>
                      <dd className="font-mono">{cert.payloadHex}</dd>
                      <dt className="text-foreground-muted">作品</dt>
                      <dd className="min-w-0 truncate">
                        {cert.work.fileName} · {cert.work.width}×{cert.work.height}
                      </dd>
                      <dt className="text-foreground-muted">签发于</dt>
                      <dd>{new Date(cert.issuedAt).toLocaleString()}</dd>
                    </dl>
                  )}
                </div>

                <ol className="flex flex-col gap-3">
                  {report.items.map((item) => {
                    const s = STATUS_ICON[item.status]
                    return (
                      <li key={item.id} className="flex gap-2.5">
                        <s.Icon className={cn("mt-0.5 size-4 shrink-0", s.cls)} aria-label={s.label} />
                        <div className="min-w-0 text-sm">
                          <p className="text-foreground-intense">{item.title}</p>
                          <p className="text-xs leading-relaxed text-foreground-muted">{item.detail}</p>
                          {item.fields && (
                            <p className="mt-1 flex flex-wrap gap-1">
                              {item.fields.map((f) => (
                                <Badge key={f} size="xs" variant="error" className="font-mono">
                                  {f}
                                </Badge>
                              ))}
                            </p>
                          )}
                          {item.id === "trust" && item.status === "warn" && cert && (
                            <Button
                              size="sm"
                              variant="soft"
                              className="mt-2"
                              onClick={() =>
                                useIdentity.getState().trust({
                                  keyId: cert.creator.keyId,
                                  publicKey: cert.creator.publicKey,
                                  label: cert.creator.name || cert.creator.keyId,
                                })
                              }
                            >
                              已线下核对，信任此公钥
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
                <p className="text-[11px] leading-relaxed text-foreground-subtle">
                  {SIGNATURE_DISCLAIMER}
                  {certTrusted ? "" : " 未信任的公钥只能说明“有人用这把密钥签了名”，是谁要靠 keyId 线下核对。"}
                </p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border p-5">
            <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-intense">
              <FileSearch className="size-4" /> 盲水印检测
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
                          <dd className="min-w-0 truncate">
                            {found.record.creatorName} · {found.record.fileName}
                          </dd>
                          <dt className="text-foreground-muted">原图 SHA-256</dt>
                          <dd className="truncate font-mono text-xs">{found.record.sourceSha256}</dd>
                        </>
                      )}
                    </dl>
                  )}
                  {found && !found.record && (
                    <p className="mt-2 text-xs text-foreground-muted">本机注册表中无此指纹；可导入创作者提供的注册表 JSON，或拖入其证书核验。</p>
                  )}
                </div>
                <ul className="flex flex-col gap-2">
                  {hits.map((h, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 text-xs">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge size="sm" variant={h.found ? "success" : "soft"}>
                          {h.engine === "cdp" ? `CDP${h.key?.startsWith("veilmark-public") ? " · 公开密钥" : " · 私有密钥"}` : "TrustMark"}
                        </Badge>
                        <span className="truncate text-foreground-muted">{h.detail}</span>
                      </span>
                      <span className="tabular-nums text-foreground-strong">{Math.round(h.confidence * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border p-5">
            <h2 className="text-sm font-medium text-foreground-intense">已信任的公钥 · {trusted.length}</h2>
            <p className="mt-1 text-xs text-foreground-muted">固定下来的公钥，下次核验时“公钥已信任”一项直接通过。</p>
            <ul className="mt-3 flex flex-col divide-y divide-border-muted text-xs">
              {trusted.map((k) => (
                <li key={k.keyId} className="flex items-center gap-3 py-2">
                  <span className="font-mono">{formatKeyId(k.keyId)}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground-strong">{k.label}</span>
                  <button
                    aria-label={`取消信任 ${k.label}`}
                    className="text-foreground-subtle hover:text-error-emphasis"
                    onClick={() => useIdentity.getState().untrust(k.keyId)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
              {!trusted.length && <li className="py-2 text-foreground-muted">暂无。核验证书后可在清单里信任对方公钥。</li>}
            </ul>
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
                  <span className="flex min-w-0 items-center gap-1.5 text-foreground-strong">
                    <span className="truncate">
                      {r.creatorName} · {r.fileName}
                    </span>
                    {r.certificate && (
                      <button
                        title="下载这条记录的签名证书"
                        className="shrink-0"
                        onClick={() =>
                          saveText(JSON.stringify(r.certificate, null, 2) + "\n", `${r.certificate!.work.fileName.replace(/\.[^.]+$/, "")}.cert.json`)
                        }
                      >
                        <Badge size="xs" variant="info">
                          证书
                        </Badge>
                      </button>
                    )}
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
