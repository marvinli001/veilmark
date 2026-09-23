"use client"

import { createStore, del, get, set } from "idb-keyval"
import { create } from "zustand"
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware"

import type { RevealKind } from "./watermark/glance/simulate"
import type { LiveKind } from "./watermark/live"
import { glancePreset, type GlanceConfig } from "./watermark/glance/types"
import { defaultJob, type PipelineReport, type WatermarkJob } from "./watermark/pipeline"
import {
  builtinTemplates,
  cloneJob,
  deepEqual,
  isBuiltinId,
  migrateJob,
  parseTemplates,
  serializeTemplates,
  templateDb,
  TEMPLATE_SCHEMA_VERSION,
  type Template,
} from "./watermark/templates"
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
  /** 按图指定模板；undefined 表示跟随当前正在编辑的参数 */
  templateId?: string
}

export type CompareMode = "slider" | "side" | "result"

interface StudioState {
  assets: Asset[]
  activeId: string | null
  job: WatermarkJob
  compare: CompareMode
  reveal: RevealKind | "diff" | "none"
  trustmarkReady: boolean

  /** 正在拖动的滑杆类别（伪隐性 / 显性）；拖动期间由实时预览接管画布 */
  interacting: LiveKind | null
  /**
   * 开始拖动那一刻当前图的处理结果。松手后画布继续显示实时预览，
   * 直到结果对象被新的全分辨率结果替换，避免中间闪回旧图。
   */
  resultBeforeInteraction: Asset["result"] | null

  /** 内置 + 用户模板（用户模板的事实来源是 IndexedDB，这里是内存镜像） */
  templates: Template[]
  templatesLoaded: boolean
  /** 当前编辑参数来自哪个模板；null 表示没有应用过模板（以 defaultJob 为基线） */
  activeTemplateId: string | null
  /** 应用/保存模板那一刻的参数快照，用来判断是否有未保存修改 */
  baseline: WatermarkJob | null
  defaultTemplateId: string | null

  addFiles(files: File[]): Promise<void>
  removeAsset(id: string): void
  setActive(id: string): void
  toggleSelected(id: string, value?: boolean): void
  selectAll(value: boolean): void
  patchAsset(id: string, patch: Partial<Asset>): void
  setAssetTemplate(id: string, templateId: string | undefined): void

  setJob(updater: (job: WatermarkJob) => WatermarkJob): void
  patchLayer(id: string, patch: (l: VisibleLayer) => VisibleLayer): void
  addLayer(kind: VisibleLayer["kind"]): void
  removeLayer(id: string): void
  patchGlance(patch: (g: GlanceConfig) => GlanceConfig): void
  setCompare(m: CompareMode): void
  setReveal(r: StudioState["reveal"]): void
  setTrustmarkReady(v: boolean): void
  setInteracting(kind: LiveKind | null): void

  loadTemplates(): Promise<void>
  applyTemplate(id: string): void
  saveTemplate(): Promise<void>
  saveAsTemplate(name: string, description?: string): Promise<string>
  createTemplate(name: string): Promise<string>
  renameTemplate(id: string, name: string, description?: string): Promise<void>
  duplicateTemplate(id: string): Promise<string>
  deleteTemplate(id: string): Promise<void>
  setDefaultTemplate(id: string | null): Promise<void>
  importTemplates(file: Blob): Promise<number>
  exportTemplates(ids: string[] | "all", includePrivateKey: boolean): Blob
}

const ACCEPT = /^image\/(png|jpe?g|webp|avif|bmp|gif)$/

async function probe(file: File) {
  const bmp = await createImageBitmap(file)
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/** 当前参数相对基线是否有未保存修改 */
export function isDirty(s: Pick<StudioState, "job" | "baseline">): boolean {
  return !deepEqual(s.job, s.baseline ?? defaultJob())
}

/**
 * 某张图实际使用的参数：
 * - 未指定模板 → 当前编辑参数；
 * - 指定的正是当前在编辑的模板 → 也用编辑中的参数（所见即所得，未保存的修改立即生效）；
 * - 其他模板 → 该模板已保存的版本。署名为空时沿用当前署名，署名属于“人”而不是“模板”。
 */
export function jobForAsset(
  s: Pick<StudioState, "job" | "templates" | "activeTemplateId">,
  asset: Pick<Asset, "templateId"> | undefined
): WatermarkJob {
  if (!asset?.templateId || asset.templateId === s.activeTemplateId) return s.job
  const t = s.templates.find((x) => x.id === asset.templateId)
  if (!t) return s.job
  if (t.job.author) return t.job
  // 补署名会产生新对象；按 (模板参数, 署名) 缓存，保证输入不变时返回同一引用，下游 effect 不会反复触发
  let byAuthor = withAuthorCache.get(t.job)
  if (!byAuthor) withAuthorCache.set(t.job, (byAuthor = new Map()))
  let j = byAuthor.get(s.job.author)
  if (!j) byAuthor.set(s.job.author, (j = { ...t.job, author: s.job.author }))
  return j
}
const withAuthorCache = new WeakMap<WatermarkJob, Map<string, WatermarkJob>>()

/**
 * 真正提交给 Worker 的参数：
 * - TrustMark 模型未加载时降级为 CDP（与预览一致）；
 * - 开启“用签名身份派生创作者 ID”时，把 creator 换成派生出的数字 ID（纯数字 < 2^24 会被原样写入指纹）。
 * 输入不变时返回同一引用，下游 effect 不会反复触发。
 */
export function processingJob(job: WatermarkJob, opts: { trustmarkReady: boolean; identityCreatorId: number | null }): WatermarkJob {
  const downgrade = job.blind.engine !== "cdp" && !opts.trustmarkReady
  const derive = job.blind.creatorFromIdentity && opts.identityCreatorId != null
  if (!downgrade && !derive) return job
  const key = `${downgrade}|${derive ? opts.identityCreatorId : ""}`
  let byOpts = processingCache.get(job)
  if (!byOpts) processingCache.set(job, (byOpts = new Map()))
  let j = byOpts.get(key)
  if (!j) {
    j = {
      ...job,
      blind: {
        ...job.blind,
        ...(downgrade ? { engine: "cdp" as const } : {}),
        ...(derive ? { creator: String(opts.identityCreatorId) } : {}),
      },
    }
    byOpts.set(key, j)
  }
  return j
}
const processingCache = new WeakMap<WatermarkJob, Map<string, WatermarkJob>>()

// ---------------------------------------------------------------------------
// 持久化：工作参数存 IndexedDB（图片水印的 dataURL 会撑爆 localStorage）
// ---------------------------------------------------------------------------

const LEGACY_KEY = "veilmark-studio"
const stateStore = () => createStore("veilmark-studio", "state")
const hasIDB = () => typeof indexedDB !== "undefined"

/** 拖动滑杆时每帧都会触发写入；合并成 400ms 一次，页面隐藏时立即落盘 */
const pending = new Map<string, string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
function flush() {
  clearTimeout(flushTimer)
  flushTimer = undefined
  for (const [k, v] of pending) set(k, v, stateStore()).catch(() => {})
  pending.clear()
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush())
}

const idbStorage: StateStorage = {
  async getItem(name) {
    if (!hasIDB()) return null
    const v = await get<string>(name, stateStore())
    if (v != null) return v
    // 一次性迁移：旧版本把参数存在 localStorage
    const legacy = typeof localStorage !== "undefined" ? localStorage.getItem(LEGACY_KEY) : null
    if (legacy) {
      await set(name, legacy, stateStore())
      localStorage.removeItem(LEGACY_KEY)
    }
    return legacy
  },
  setItem(name, value) {
    if (!hasIDB()) return
    pending.set(name, value)
    flushTimer ??= setTimeout(flush, 400)
  },
  async removeItem(name) {
    if (hasIDB()) await del(name, stateStore())
  },
}

interface Persisted {
  job: WatermarkJob
  compare: CompareMode
  activeTemplateId: string | null
  baseline: WatermarkJob | null
}

const stamp = () => new Date().toISOString()

/** 本次启动时存储里是否已有参数；没有才套用默认模板，免得覆盖用户上次没保存的编辑 */
let restoredFromStorage = false

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => {
      /** 写回一个用户模板并同步内存镜像 */
      async function upsert(t: Template) {
        await templateDb.put(t)
        set((s) => {
          const exists = s.templates.some((x) => x.id === t.id)
          return { templates: exists ? s.templates.map((x) => (x.id === t.id ? t : x)) : [...s.templates, t] }
        })
      }

      function newTemplate(name: string, job: WatermarkJob, description?: string): Template {
        const now = stamp()
        return {
          id: crypto.randomUUID(),
          name,
          ...(description ? { description } : {}),
          job: cloneJob(job),
          schemaVersion: TEMPLATE_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        }
      }

      return {
        assets: [],
        activeId: null,
        job: defaultJob(),
        compare: "slider",
        reveal: "none",
        trustmarkReady: false,
        interacting: null,
        resultBeforeInteraction: null,

        templates: builtinTemplates(),
        templatesLoaded: false,
        activeTemplateId: null,
        baseline: null,
        defaultTemplateId: null,

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
        setAssetTemplate: (id, templateId) =>
          set((s) => ({ assets: s.assets.map((a) => (a.id === id ? { ...a, templateId } : a)) })),

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
        setInteracting: (kind) =>
          set((s) => {
            if (kind === s.interacting) return {}
            if (!kind) return { interacting: null }
            // 上一次松手后新结果还没回来就再次拖动时，current 仍是那份旧结果，逻辑自然成立
            const current = s.assets.find((a) => a.id === s.activeId)?.result ?? null
            return { interacting: kind, resultBeforeInteraction: current }
          }),

        async loadTemplates() {
          const [user, defaultTemplateId] = await Promise.all([templateDb.list(), templateDb.getDefaultId()])
          set((s) => ({
            templates: [...builtinTemplates(), ...user],
            templatesLoaded: true,
            defaultTemplateId: defaultTemplateId ?? null,
            // 指向已被删除模板的图片退回“跟随当前”
            assets: s.assets.map((a) =>
              a.templateId && !isBuiltinId(a.templateId) && !user.some((t) => t.id === a.templateId)
                ? { ...a, templateId: undefined }
                : a
            ),
          }))
        },

        applyTemplate(id) {
          const s = get()
          const t = s.templates.find((x) => x.id === id)
          if (!t) return
          const job = cloneJob(t.job)
          // 署名与创作者属于“人”：模板里留空时沿用当前值，切换模板不必重填
          if (!job.author) job.author = s.job.author
          if (!job.blind.creator) job.blind = { ...job.blind, creator: s.job.blind.creator }
          set({ job, activeTemplateId: t.id, baseline: cloneJob(job) })
        },

        async saveTemplate() {
          const s = get()
          const t = s.templates.find((x) => x.id === s.activeTemplateId)
          if (!t || t.builtin) return
          const next: Template = { ...t, job: cloneJob(s.job), updatedAt: stamp() }
          // 用户补填了私钥后，“已去除私钥”的提示就不再成立
          if (next.privateKeyStripped && next.job.blind.key) delete next.privateKeyStripped
          await upsert(next)
          set({ baseline: cloneJob(s.job) })
        },

        async saveAsTemplate(name, description) {
          const s = get()
          const t = newTemplate(name, s.job, description)
          await upsert(t)
          set({ activeTemplateId: t.id, baseline: cloneJob(s.job) })
          return t.id
        },

        async createTemplate(name) {
          const t = newTemplate(name, { ...defaultJob(), author: get().job.author })
          await upsert(t)
          get().applyTemplate(t.id)
          return t.id
        },

        async renameTemplate(id, name, description) {
          const t = get().templates.find((x) => x.id === id)
          if (!t || t.builtin) return
          const next: Template = { ...t, name, updatedAt: stamp() }
          if (description) next.description = description
          else delete next.description
          await upsert(next)
        },

        async duplicateTemplate(id) {
          const t = get().templates.find((x) => x.id === id)
          if (!t) throw new Error("模板不存在")
          const copy = newTemplate(`${t.name} 副本`, t.job, t.description)
          if (t.privateKeyStripped) copy.privateKeyStripped = true
          await upsert(copy)
          return copy.id
        },

        async deleteTemplate(id) {
          if (isBuiltinId(id)) return
          await templateDb.remove(id)
          const s = get()
          if (s.defaultTemplateId === id) await templateDb.setDefaultId(null)
          set({
            templates: s.templates.filter((x) => x.id !== id),
            defaultTemplateId: s.defaultTemplateId === id ? null : s.defaultTemplateId,
            assets: s.assets.map((a) => (a.templateId === id ? { ...a, templateId: undefined } : a)),
            // 删掉正在编辑的模板时参数保留，只是不再关联（界面会显示“未保存”）
            ...(s.activeTemplateId === id ? { activeTemplateId: null, baseline: null } : {}),
          })
        },

        async setDefaultTemplate(id) {
          await templateDb.setDefaultId(id)
          set({ defaultTemplateId: id })
        },

        async importTemplates(file) {
          const parsed = parseTemplates(await file.text())
          const now = stamp()
          // 与内置模板同 id 的一律换新 id（内置只读）；与已有用户模板同 id 视为同一模板的新版本，直接覆盖
          const list = parsed.map((t) => (isBuiltinId(t.id) ? { ...t, id: crypto.randomUUID(), createdAt: now } : t))
          await templateDb.putMany(list)
          set((s) => ({
            templates: [...s.templates.filter((x) => !list.some((t) => t.id === x.id)), ...list],
          }))
          return list.length
        },

        exportTemplates(ids, includePrivateKey) {
          const s = get()
          const list = ids === "all" ? s.templates.filter((t) => !t.builtin) : s.templates.filter((t) => ids.includes(t.id))
          return new Blob([serializeTemplates(list, { includePrivateKey })], { type: "application/json" })
        },
      }
    },
    {
      name: "veilmark-studio",
      version: 2,
      storage: createJSONStorage(() => idbStorage),
      // 只持久化配置，图片与结果不入库
      partialize: (s): Persisted => ({
        job: s.job,
        compare: s.compare,
        activeTemplateId: s.activeTemplateId,
        baseline: s.baseline,
      }),
      // v1（localStorage 时代）只有 job 与 compare，字段缺失由 merge 里的 migrateJob 兜底
      migrate: (persisted) => persisted as Persisted,
      merge: (persisted, current) => {
        restoredFromStorage = persisted != null
        const p = (persisted ?? {}) as Partial<Persisted>
        return {
          ...current,
          compare: p.compare ?? current.compare,
          job: p.job ? migrateJob(p.job) : current.job,
          activeTemplateId: p.activeTemplateId ?? null,
          baseline: p.baseline ? migrateJob(p.baseline) : null,
        }
      },
      onRehydrateStorage: () => (state) => {
        if (!state || !hasIDB()) return
        state.loadTemplates().then(() => {
          const s = useStudio.getState()
          if (!restoredFromStorage && s.defaultTemplateId) s.applyTemplate(s.defaultTemplateId)
        })
      },
    }
  )
)

export { glancePreset }
