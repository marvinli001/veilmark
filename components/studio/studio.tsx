"use client"

import { Input } from "@appica/ui-react/input"
import { ScrollArea } from "@appica/ui-react/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appica/ui-react/tabs"
import { useEffect, useRef, useState } from "react"

import { AppHeader } from "@/components/app-header"
import { TemplateSwitcher } from "@/components/templates/template-switcher"
import { useIdentity } from "@/lib/identity-store"
import { jobForAsset, processingJob, useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { liveSupport } from "@/lib/watermark/live"
import { previewWorker } from "@/lib/workers/client"

import { AssetStrip } from "./asset-strip"
import { ExportBar } from "./export-bar"
import { useLive } from "./live-preview"
import { BlindPanel } from "./panels/blind-panel"
import { ExportPanel } from "./panels/export-panel"
import { GlancePanel } from "./panels/glance-panel"
import { VisiblePanel } from "./panels/visible-panel"
import { Stage } from "./stage"

/** 三种水印的开关状态，用于标签页上的圆点提示 */
function Dot({ on }: { on: boolean }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success-emphasis" : "bg-border-strong")} />
}

/** 署名（{author} 变量与盲水印创作者的默认值）：宽屏在顶栏内联，窄屏在“更多”弹层里 */
function AuthorField() {
  const author = useStudio((s) => s.job.author)
  const setJob = useStudio((s) => s.setJob)
  return (
    <label className="flex flex-col gap-1.5 md:block">
      <span className="text-xs text-foreground-muted md:sr-only">署名（用于 {"{author}"} 变量与盲水印）</span>
      <Input
        inputSize="sm"
        className="w-full md:w-44"
        placeholder="署名 {author}"
        value={author}
        onChange={(e) => setJob((j) => ({ ...j, author: e.target.value }))}
      />
    </label>
  )
}

export function Studio() {
  const { assets, activeId, job, addFiles, patchAsset, trustmarkReady, templates, activeTemplateId } = useStudio()
  const active = assets.find((a) => a.id === activeId)
  // 预览用“这张图实际会用的参数”：指定了其他模板的图显示该模板的效果（jobForAsset 输入不变时引用稳定）
  const pinnedId = active?.templateId
  const assetJob = jobForAsset({ job, templates, activeTemplateId }, { templateId: pinnedId })
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const seq = useRef(0)
  const identityCreatorId = useIdentity((s) => s.creatorId)

  useEffect(() => {
    const id = useIdentity.getState()
    id.load().then(() => id.ensure())
  }, [])

  // 拖动滑杆时能否交给实时预览：能则暂停 CPU 管线，松手后再算一次全分辨率；不能则维持防抖 + CPU
  const interacting = useStudio((s) => s.interacting)
  const reveal = useStudio((s) => s.reveal)
  const caps = useLive((s) => s.caps)
  const support =
    interacting && active
      ? liveSupport(interacting, {
          caps,
          width: active.width,
          height: active.height,
          job: assetJob,
          reveal,
          pinned: !!pinnedId && pinnedId !== activeTemplateId,
        })
      : null
  const paused = !!support?.ok
  const activeIndex = assets.findIndex((a) => a.id === activeId)

  // 粘贴上传（截图工具复制后直接 ⌘V）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) addFiles(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [addFiles])

  // 参数变化 → 防抖 → Worker 全分辨率处理（伪隐性水印是逐像素的，不能用缩略代理预览）
  useEffect(() => {
    if (!active) return
    const id = ++seq.current
    // 拖动中：作废在途结果（否则它落地后会被当成“新结果”，把实时预览换回旧图），等松手再算
    if (paused) return
    const effective = processingJob(assetJob, { trustmarkReady, identityCreatorId })
    const timer = setTimeout(async () => {
      setBusy(true)
      patchAsset(active.id, { status: "processing" })
      try {
        const index = useStudio.getState().assets.findIndex((a) => a.id === active.id)
        const r = await previewWorker().process(active.file, effective, {
          author: effective.author,
          filename: active.name,
          index,
          date: new Date(),
        })
        if (id !== seq.current) return
        const prev = useStudio.getState().assets.find((a) => a.id === active.id)?.result
        if (prev) URL.revokeObjectURL(prev.url)
        patchAsset(active.id, { status: "done", error: undefined, result: { ...r, url: URL.createObjectURL(r.blob) } })
      } catch (e) {
        if (id === seq.current) patchAsset(active.id, { status: "error", error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (id === seq.current) setBusy(false)
      }
    }, 280)
    return () => clearTimeout(timer)
    // 只在图片或配置变化时重跑；patchAsset 引用稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, assetJob, trustmarkReady, paused, identityCreatorId])

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-background"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <AppHeader extra={<AuthorField />}>
        <TemplateSwitcher />
      </AppHeader>

      {/* 竖屏：上图下参数；宽屏/横屏：左图右参数（断点见 globals.css 的 wide 变体） */}
      <div className="flex min-h-0 flex-1 flex-col wide:flex-row">
        <main className="flex h-[46dvh] min-h-64 shrink-0 flex-col bg-background-subtle/40 md:h-[52dvh] wide:h-auto wide:min-h-0 wide:min-w-0 wide:flex-1 wide:shrink">
          <Stage asset={active} busy={busy} author={assetJob.author} index={activeIndex} support={support} />
          <AssetStrip />
        </main>
        <aside className="flex min-h-0 flex-1 flex-col border-t border-border wide:w-88 wide:flex-none wide:border-t-0 wide:border-l xl:w-96">
          <Tabs defaultValue="visible" size="sm" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="shrink-0 px-3 pt-3 pb-1">
              <TabsList className="w-full">
                <TabsTrigger value="visible" className="flex-1">
                  显性 <Dot on={job.visible.some((l) => l.enabled)} />
                </TabsTrigger>
                <TabsTrigger value="glance" className="flex-1">
                  伪隐性 <Dot on={job.glance.enabled} />
                </TabsTrigger>
                <TabsTrigger value="blind" className="flex-1">
                  盲水印 <Dot on={job.blind.enabled} />
                </TabsTrigger>
                <TabsTrigger value="export" className="flex-1">
                  导出
                </TabsTrigger>
              </TabsList>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <TabsContent value="visible">
                <VisiblePanel />
              </TabsContent>
              <TabsContent value="glance">
                <GlancePanel />
              </TabsContent>
              <TabsContent value="blind">
                <BlindPanel />
              </TabsContent>
              <TabsContent value="export">
                <ExportPanel activeAsset={active} />
              </TabsContent>
            </ScrollArea>
          </Tabs>
          <ExportBar activeAsset={active} />
        </aside>
      </div>

      {dragOver && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-secondary-emphasis bg-secondary-subtle">
          <p className="text-sm font-medium text-foreground-intense">松开即可添加图片</p>
        </div>
      )}
    </div>
  )
}
