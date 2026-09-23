"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { RevealKind } from "./watermark/glance/simulate"
import { glancePreset, type GlanceConfig } from "./watermark/glance/types"
import { defaultJob, type PipelineReport, type WatermarkJob } from "./watermark/pipeline"
import { defaultLayer, type VisibleLayer } from "./watermark/visible/types"

export interface Asset {
  id: string
  file: File
  name: string
  url: string
  width: number
  height: number
  selected: boolean
  status: "idle" | "processing" | "done" | "error"
  result?: { blob: Blob; url: string; report: PipelineReport; width: number; height: number }
  error?: string
}

export type CompareMode = "slider" | "side" | "result"

interface StudioState {
  assets: Asset[]
  activeId: string | null
  job: WatermarkJob
  compare: CompareMode
  reveal: RevealKind | "diff" | "none"
  trustmarkReady: boolean

  addFiles(files: File[]): Promise<void>
  removeAsset(id: string): void
  setActive(id: string): void
  toggleSelected(id: string, value?: boolean): void
  selectAll(value: boolean): void
  patchAsset(id: string, patch: Partial<Asset>): void

  setJob(updater: (job: WatermarkJob) => WatermarkJob): void
  patchLayer(id: string, patch: (l: VisibleLayer) => VisibleLayer): void
  addLayer(kind: VisibleLayer["kind"]): void
  removeLayer(id: string): void
  patchGlance(patch: (g: GlanceConfig) => GlanceConfig): void
  setCompare(m: CompareMode): void
  setReveal(r: StudioState["reveal"]): void
  setTrustmarkReady(v: boolean): void
}

const ACCEPT = /^image\/(png|jpe?g|webp|avif|bmp|gif)$/

async function probe(file: File) {
  const bmp = await createImageBitmap(file)
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
      assets: [],
      activeId: null,
      job: defaultJob(),
      compare: "slider",
      reveal: "none",
      trustmarkReady: false,

      async addFiles(files) {
        const accepted = files.filter((f) => ACCEPT.test(f.type))
        const added: Asset[] = []
        for (const file of accepted) {
          try {
            const { width, height } = await probe(file)
            added.push({
              id: crypto.randomUUID(),
              file,
              name: file.name || `pasted-${Date.now()}.png`,
              url: URL.createObjectURL(file),
              width,
              height,
              selected: true,
              status: "idle",
            })
          } catch {
            // 无法解码的文件直接忽略（例如浏览器不支持的 HEIC）
          }
        }
        if (!added.length) return
        set((s) => ({ assets: [...s.assets, ...added], activeId: s.activeId ?? added[0].id }))
      },
      removeAsset(id) {
        const a = get().assets.find((x) => x.id === id)
        if (a) {
          URL.revokeObjectURL(a.url)
          if (a.result) URL.revokeObjectURL(a.result.url)
        }
        set((s) => {
          const assets = s.assets.filter((x) => x.id !== id)
          return { assets, activeId: s.activeId === id ? (assets[0]?.id ?? null) : s.activeId }
        })
      },
      setActive: (id) => set({ activeId: id, reveal: "none" }),
      toggleSelected: (id, value) =>
        set((s) => ({ assets: s.assets.map((a) => (a.id === id ? { ...a, selected: value ?? !a.selected } : a)) })),
      selectAll: (value) => set((s) => ({ assets: s.assets.map((a) => ({ ...a, selected: value })) })),
      patchAsset: (id, patch) =>
        set((s) => ({ assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),

      setJob: (updater) => set((s) => ({ job: updater(s.job) })),
      patchLayer: (id, patch) =>
        set((s) => ({ job: { ...s.job, visible: s.job.visible.map((l) => (l.id === id ? patch(l) : l)) } })),
      addLayer: (kind) =>
        set((s) => {
          const layer = defaultLayer()
          layer.kind = kind
          layer.name = kind === "image" ? "图片水印" : `文字水印 ${s.job.visible.length + 1}`
          if (kind === "image") layer.layout = { ...layer.layout, mode: "single", anchor: "bottom-right", rotation: 0 }
          return { job: { ...s.job, visible: [...s.job.visible, layer] } }
        }),
      removeLayer: (id) => set((s) => ({ job: { ...s.job, visible: s.job.visible.filter((l) => l.id !== id) } })),
      patchGlance: (patch) => set((s) => ({ job: { ...s.job, glance: patch(s.job.glance) } })),
      setCompare: (compare) => set({ compare }),
      setReveal: (reveal) => set({ reveal }),
      setTrustmarkReady: (trustmarkReady) => set({ trustmarkReady }),
    }),
    {
      name: "veilmark-studio",
      version: 1,
      // 只持久化配置（水印模板），图片与结果不入库
      partialize: (s) => ({ job: s.job, compare: s.compare }),
      merge: (persisted, current) => {
        const p = persisted as Partial<StudioState> | undefined
        return { ...current, ...p, job: { ...current.job, ...(p?.job ?? {}) } }
      },
    }
  )
)

export { glancePreset }
