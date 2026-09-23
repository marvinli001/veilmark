import { createStore, del, entries, get, set, setMany } from "idb-keyval"

import { DEFAULT_KEY } from "./blind/classic"
import { glancePreset } from "./glance/types"
import { defaultJob, type WatermarkJob } from "./pipeline"
import { ANCHORS } from "./visible/layout"
import { defaultLayer, defaultTextStyle, type VisibleLayer } from "./visible/types"

/**
 * 水印模板：一份完整的 WatermarkJob 加元信息。
 *
 * 为什么存 IndexedDB 而不是 localStorage：图片水印图层的 image.src 是 dataURL，
 * 一个 Logo 就可能几百 KB，几个模板就会撑爆 localStorage 的 5 MB 上限。
 *
 * 模板会跨版本流转（本机旧数据、别人导出的 JSON），所以读入时一律过 migrateJob：
 * 以 defaultJob() 为基准深合并，缺字段补默认、类型不对回退默认、未知字段保留。
 */

export const TEMPLATE_SCHEMA_VERSION = 1
export const TEMPLATE_FILE_FORMAT = "veilmark.templates/v1"

export interface Template {
  id: string
  name: string
  description?: string
  job: WatermarkJob
  schemaVersion: number
  createdAt: string
  updatedAt: string
  /** 内置起步模板：只读，只能复制后修改 */
  builtin?: boolean
  /** 导出时私有密钥已被去除（导入后 blind.key 为空，需要用户重新填写） */
  privateKeyStripped?: boolean
}

// ---------------------------------------------------------------------------
// migrateJob：深合并补齐
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

/** 取值必须落在枚举内，否则回退默认值（手改 JSON 或旧版本的非法值不应让管线崩溃） */
const ENUMS: Record<string, readonly string[]> = {
  "blind.engine": ["cdp", "trustmark", "dual"],
  "blind.serialMode": ["hash", "index", "manual"],
  "export.format": ["png", "webp-lossless", "webp", "jpeg"],
  "glance.mode": ["daily", "print", "screenshot", "hybrid", "custom"],
  "glance.grating.kind": ["checker", "lines"],
  "glance.chroma.axis": ["auto", "blue-yellow", "red-green"],
  "glance.layout.mode": ["single", "tile", "band"],
  "layer.kind": ["text", "image"],
  "layer.layout.mode": ["single", "tile", "band"],
  "layer.layout.anchor": [...ANCHORS, "smart"],
  "layer.text.align": ["left", "center", "right"],
  "layer.blend": [
    "source-over",
    "multiply",
    "screen",
    "overlay",
    "soft-light",
    "hard-light",
    "difference",
    "exclusion",
    "color-dodge",
    "color-burn",
    "luminosity",
  ],
  "fill.type": ["solid", "linear"],
}

/**
 * 以 base 为骨架合并 input：
 * - 对象递归；键顺序以 base 为准，input 里多出来的键追加在后（向前兼容新版本字段）；
 * - 基本类型必须与 base 同类型，数字还必须有限，否则取 base；
 * - 数组整体取 input（元素结构由调用方按路径单独迁移）。
 */
function mergeInto(base: unknown, input: unknown, path: string): unknown {
  if (isObj(base)) {
    if (!isObj(input)) return base
    const out: Obj = {}
    for (const k of Object.keys(base)) out[k] = mergeInto(base[k], input[k], path ? `${path}.${k}` : k)
    for (const k of Object.keys(input)) if (!(k in out) && input[k] !== undefined) out[k] = input[k]
    return out
  }
  if (Array.isArray(base)) return Array.isArray(input) ? input : base
  if (typeof base === "number") return typeof input === "number" && Number.isFinite(input) ? input : base
  if (typeof input !== typeof base) return base
  const allowed = ENUMS[path]
  if (allowed && !allowed.includes(input as string)) return base
  return input
}

const DEFAULT_STOPS = [
  { offset: 0, color: "#ffffff" },
  { offset: 1, color: "#9ca3af" },
]

/** fill 是判别联合，不能拿纯色默认值去深合并渐变（会混入无关的 color 字段） */
function migrateFill(input: unknown): VisibleLayer["text"]["fill"] {
  if (isObj(input) && input.type === "linear") {
    const stops = Array.isArray(input.stops)
      ? input.stops
          .filter(isObj)
          .map((s) => ({
            offset: typeof s.offset === "number" && Number.isFinite(s.offset) ? s.offset : 0,
            color: typeof s.color === "string" ? s.color : "#ffffff",
          }))
      : []
    return {
      type: "linear",
      angle: typeof input.angle === "number" && Number.isFinite(input.angle) ? input.angle : 0,
      stops: stops.length >= 2 ? stops : DEFAULT_STOPS.map((s) => ({ ...s })),
    }
  }
  return mergeInto(defaultTextStyle().fill, input, "fill") as VisibleLayer["text"]["fill"]
}

function migrateLayer(input: unknown, index: number): VisibleLayer {
  const src = isObj(input) ? input : {}
  const id = typeof src.id === "string" && src.id ? src.id : `layer-${index + 1}`
  const merged = mergeInto(defaultLayer(id), src, "layer") as VisibleLayer
  merged.text = { ...merged.text, fill: migrateFill(isObj(src.text) ? src.text.fill : undefined) }
  // image 是可选字段：结构不对就丢掉，免得渲染时读到 undefined.src
  if (isObj(src.image) && typeof src.image.src === "string") {
    merged.image = {
      src: src.image.src,
      width: typeof src.image.width === "number" && Number.isFinite(src.image.width) ? src.image.width : 18,
    }
  } else delete merged.image
  return merged
}

export function migrateJob(input: unknown): WatermarkJob {
  const src = isObj(input) ? input : {}
  const base = defaultJob()
  const job = mergeInto(base, src, "") as WatermarkJob
  // glance 以对应预设为骨架：旧模板缺某个触发层时，补上的是“同一预设”下的合理值
  const g = isObj(src.glance) ? src.glance : {}
  const presetMode = g.mode === "print" || g.mode === "screenshot" || g.mode === "hybrid" ? g.mode : "daily"
  const glanceBase = { ...glancePreset(presetMode), enabled: false }
  job.glance = mergeInto(glanceBase, g, "glance") as WatermarkJob["glance"]
  job.glance.text = { ...job.glance.text, fill: migrateFill(isObj(g.text) ? g.text.fill : undefined) }
  job.visible = Array.isArray(src.visible) ? src.visible.map(migrateLayer) : base.visible
  return job
}

export function migrateTemplate(input: unknown, now = new Date().toISOString()): Template {
  const src = isObj(input) ? input : {}
  const t: Template = {
    id: typeof src.id === "string" && src.id ? src.id : crypto.randomUUID(),
    name: typeof src.name === "string" && src.name.trim() ? src.name : "未命名模板",
    job: migrateJob(src.job),
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    createdAt: typeof src.createdAt === "string" ? src.createdAt : now,
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : now,
  }
  if (typeof src.description === "string" && src.description) t.description = src.description
  if (src.privateKeyStripped === true) t.privateKeyStripped = true
  return t
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

/** 结构相等（与键顺序无关）：用于判断“当前参数相对已应用模板是否有未保存修改” */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

export const cloneJob = (job: WatermarkJob): WatermarkJob => structuredClone(job)

// ---------------------------------------------------------------------------
// 内置起步模板
// ---------------------------------------------------------------------------

const BUILTIN_TIME = "2026-01-01T00:00:00.000Z"

function builtin(id: string, name: string, description: string, build: (job: WatermarkJob) => void): Template {
  const job = defaultJob()
  build(job)
  return {
    id: `builtin:${id}`,
    name,
    description,
    job,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    createdAt: BUILTIN_TIME,
    updatedAt: BUILTIN_TIME,
    builtin: true,
  }
}

/** 每次调用都返回新对象，调用方随意修改也不会污染内置定义 */
export function builtinTemplates(): Template[] {
  return [
    builtin("social", "社媒分享", "右下角单点署名 + CDP 盲水印。平台会二次压缩，盲水印能扛住 JPEG q50", (j) => {
      const l = defaultLayer("social-sign")
      l.name = "角标署名"
      l.text = { ...l.text, fontSize: 2.6 }
      l.layout = { ...l.layout, mode: "single", anchor: "bottom-right", rotation: 0, margin: 3 }
      l.opacity = 0.85
      j.visible = [l]
      j.export = { ...j.export, format: "jpeg", quality: 0.92 }
    }),
    builtin("portfolio", "作品集防盗", "平铺淡水印 + 伪隐性“日常隐藏” + 双引擎盲水印（抗裁剪）", (j) => {
      const l = defaultLayer("portfolio-tile")
      l.name = "平铺水印"
      l.opacity = 0.16
      j.visible = [l]
      j.glance = { ...glancePreset("daily"), enabled: true }
      j.blind = { ...j.blind, engine: "dual" }
    }),
    builtin("print", "打印防伪", "伪隐性“打印显形” + CDP。适屏看不出，打印或最近邻缩放后浮现；须无损导出", (j) => {
      j.visible = []
      j.glance = { ...glancePreset("print"), enabled: true }
    }),
    builtin("document", "证件/合同", "斜带大字限定用途 + 伪隐性“抗截图” + CDP，适合身份证、合同扫描件外发", (j) => {
      const l = defaultLayer("document-band")
      l.name = "用途声明"
      l.text = {
        ...l.text,
        content: "仅供指定用途使用 · 他用无效",
        fontSize: 6,
        fontWeight: 700,
        fill: { type: "solid", color: "rgba(40,40,40,1)" },
        shadow: { ...l.text.shadow, enabled: false },
      }
      l.layout = { ...l.layout, mode: "band", rotation: -30, gapX: 0.25 }
      l.opacity = 0.3
      l.blend = "multiply"
      j.visible = [l]
      j.glance = { ...glancePreset("screenshot"), enabled: true }
    }),
  ]
}

export const isBuiltinId = (id: string | null | undefined) => !!id && id.startsWith("builtin:")

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

export interface TemplateFile {
  format: typeof TEMPLATE_FILE_FORMAT
  templates: Array<Omit<Template, "builtin">>
}

/** 自定义私钥 = 非空且不是公开默认密钥 */
export const hasPrivateKey = (job: WatermarkJob) => job.blind.key !== "" && job.blind.key !== DEFAULT_KEY

/**
 * 序列化为 JSON 文本。默认去掉私有密钥（模板常被分享给同事，私钥泄露后别人就能检出/伪造你的指纹），
 * 并加 privateKeyStripped 标记，导入方据此提示重新填写。
 *
 * 输出是确定性的（不写导出时间、键顺序固定），所以“导入后再导出”与原文件逐字节一致。
 */
export function serializeTemplates(templates: Template[], opts: { includePrivateKey?: boolean } = {}): string {
  const file: TemplateFile = {
    format: TEMPLATE_FILE_FORMAT,
    templates: templates.map((t) => {
      const job = migrateJob(t.job)
      let stripped = t.privateKeyStripped === true && job.blind.key === ""
      if (!opts.includePrivateKey && hasPrivateKey(job)) {
        job.blind = { ...job.blind, key: "" }
        stripped = true
      }
      const out: Omit<Template, "builtin"> = {
        id: t.id,
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        schemaVersion: TEMPLATE_SCHEMA_VERSION,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        ...(stripped ? { privateKeyStripped: true } : {}),
        job,
      }
      return out
    }),
  }
  return JSON.stringify(file, null, 2) + "\n"
}

/** 接受完整导出文件、单个模板对象、或模板数组；每个模板都会迁移补齐 */
export function parseTemplates(text: string): Template[] {
  const parsed: unknown = JSON.parse(text)
  const list = isObj(parsed) && Array.isArray(parsed.templates) ? parsed.templates : Array.isArray(parsed) ? parsed : [parsed]
  const out = list.filter((t) => isObj(t) && isObj(t.job)).map((t) => migrateTemplate(t))
  if (!out.length) throw new Error("文件里没有可识别的 Veilmark 模板")
  return out
}

// ---------------------------------------------------------------------------
// IndexedDB 存储（单独的库，不与注册表共用：idb-keyval 一个库只建一个 store）
// ---------------------------------------------------------------------------

const templateStore = () => createStore("veilmark-templates", "templates")
const metaStore = () => createStore("veilmark-templates-meta", "meta")

export const templateDb = {
  async list(): Promise<Template[]> {
    const all = await entries<string, unknown>(templateStore())
    return all.map(([, v]) => migrateTemplate(v)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },
  put: (t: Template) => set(t.id, { ...t, builtin: undefined }, templateStore()),
  putMany: (ts: Template[]) => setMany(ts.map((t) => [t.id, { ...t, builtin: undefined }]), templateStore()),
  remove: (id: string) => del(id, templateStore()),
  getDefaultId: () => get<string>("defaultTemplateId", metaStore()),
  setDefaultId: (id: string | null) => (id ? set("defaultTemplateId", id, metaStore()) : del("defaultTemplateId", metaStore())),
}
