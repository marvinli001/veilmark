"use client"

import { Input } from "@appica/ui-react/input"
import { ScrollArea } from "@appica/ui-react/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appica/ui-react/tabs"
import { useEffect, useMemo, useRef, useState } from "react"

import { AppHeader } from "@/components/app-header"
import { TemplateSwitcher } from "@/components/templates/template-switcher"
import { jobForAsset, useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { WatermarkJob } from "@/lib/watermark/pipeline"
import { previewWorker } from "@/lib/workers/client"

import { AssetRail } from "./asset-rail"
import { BlindPanel } from "./panels/blind-panel"
import { ExportPanel } from "./panels/export-panel"
import { GlancePanel } from "./panels/glance-panel"
import { VisiblePanel } from "./panels/visible-panel"
import { Stage } from "./stage"

/** 三种水印的开关状态，用于标签页上的圆点提示 */
function Dot({ on }: { on: boolean }) {
  return <span className={cn("size-1.5 rounded-full", on ? "bg-success-emphasis" : "bg-border-strong")} />
}

export function Studio() {
  const { assets, activeId, job, addFiles, patchAsset, setJob, trustmarkReady, templates, activeTemplateId } = useStudio()
  const active = assets.find((a) => a.id === activeId)
  // 预览用“这张图实际会用的参数”：指定了其他模板的图显示该模板的效果
  // 注意 jobForAsset 可能返回新对象（补署名），必须 memo，否则每次渲染都会触发重算
  const pinnedId = active?.templateId
  const assetJob = useMemo(
    () => jobForAsset({ job, templates, activeTemplateId }, { templateId: pinnedId }),
    [job, templates, activeTemplateId, pinnedId]
  )
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const seq = useRef(0)

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
    const effective: WatermarkJob =
      assetJob.blind.engine !== "cdp" && !trustmarkReady ? { ...assetJob, blind: { ...assetJob.blind, engine: "cdp" } } : assetJob
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
  }, [active?.id, assetJob, trustmarkReady])

  return (
    <div
      className="flex min-h-dvh flex-col bg-background lg:h-dvh"
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
      <AppHeader>
        <TemplateSwitcher />
        <Input
          inputSize="sm"
          className="hidden w-48 sm:flex"
          placeholder="署名 {author}"
          value={job.author}
          onChange={(e) => setJob((j) => ({ ...j, author: e.target.value }))}
        />
      </AppHeader>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[15rem_1fr_22.5rem]">
        <AssetRail />
        <main className="h-[62vh] min-h-0 min-w-0 bg-background-subtle/40 lg:h-auto">
          <Stage asset={active} busy={busy} />
        </main>
        <aside className="flex min-h-[70vh] flex-col border-t border-border lg:min-h-0 lg:border-t-0 lg:border-l">
          <Tabs defaultValue="visible" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b border-border px-3 py-2">
              <TabsList className="w-full">
                <TabsTrigger value="visible" className="flex-1 gap-1.5">
                  显性 <Dot on={job.visible.some((l) => l.enabled)} />
                </TabsTrigger>
                <TabsTrigger value="glance" className="flex-1 gap-1.5">
                  伪隐性 <Dot on={job.glance.enabled} />
                </TabsTrigger>
                <TabsTrigger value="blind" className="flex-1 gap-1.5">
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
