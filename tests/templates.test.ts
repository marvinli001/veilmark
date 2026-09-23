import { describe, expect, it } from "vitest"

import { DEFAULT_KEY } from "../lib/watermark/blind/classic"
import { defaultJob } from "../lib/watermark/pipeline"
import {
  builtinTemplates,
  deepEqual,
  migrateJob,
  parseTemplates,
  serializeTemplates,
  type Template,
} from "../lib/watermark/templates"

function userTemplate(patch: (t: Template) => void = () => {}): Template {
  const t: Template = {
    id: "tpl-1",
    name: "我的模板",
    description: "测试用",
    job: defaultJob(),
    schemaVersion: 1,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  }
  patch(t)
  return t
}

describe("migrateJob", () => {
  it("空对象 / 非对象补齐为 defaultJob", () => {
    expect(migrateJob({})).toEqual(defaultJob())
    expect(migrateJob(null)).toEqual(defaultJob())
    expect(migrateJob("garbage")).toEqual(defaultJob())
  })

  it("旧模板缺失的深层字段被补齐，已有字段保留", () => {
    const old = {
      author: "Marvin",
      visible: [{ id: "a", text: { content: "hi", fontSize: 7 }, layout: { mode: "single" } }],
      glance: { enabled: true, mode: "print", grating: { amplitude: 6 } },
      blind: { engine: "dual" },
    }
    const j = migrateJob(old)
    expect(j.author).toBe("Marvin")
    expect(j.visible[0].text.content).toBe("hi")
    expect(j.visible[0].text.fontSize).toBe(7)
    expect(j.visible[0].text.fill).toEqual({ type: "solid", color: "#ffffff" })
    expect(j.visible[0].layout.mode).toBe("single")
    expect(j.visible[0].layout.gapX).toBeTypeOf("number")
    expect(j.visible[0].opacity).toBeTypeOf("number")
    // glance 以对应预设为骨架：print 预设的防复印底纹被补上
    expect(j.glance.grating.amplitude).toBe(6)
    expect(j.glance.grating.kind).toBe("checker")
    expect(j.glance.pantograph.enabled).toBe(true)
    expect(j.glance.chroma.axis).toBe("auto")
    expect(j.blind.engine).toBe("dual")
    expect(j.blind.key).toBe(DEFAULT_KEY)
    expect(j.export.format).toBe("png")
  })

  it("非法类型与越界枚举回退默认值，未知字段保留", () => {
    const j = migrateJob({
      blind: { engine: "quantum", strength: "strong", futureField: 1 },
      export: { format: "gif", quality: Number.NaN },
    }) as ReturnType<typeof migrateJob> & { blind: { futureField?: number } }
    expect(j.blind.engine).toBe("cdp")
    expect(j.blind.strength).toBe(5)
    expect(j.blind.futureField).toBe(1)
    expect(j.export.format).toBe("png")
    expect(j.export.quality).toBe(0.95)
  })

  it("渐变填充不会混入纯色字段，图片图层保留 src", () => {
    const j = migrateJob({
      visible: [
        { id: "g", text: { fill: { type: "linear", angle: 45, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } } },
        { id: "img", kind: "image", image: { src: "data:image/png;base64,AAAA", width: 20 } },
      ],
    })
    expect(j.visible[0].text.fill).toEqual({
      type: "linear",
      angle: 45,
      stops: [
        { offset: 0, color: "#000" },
        { offset: 1, color: "#fff" },
      ],
    })
    expect(j.visible[1].image).toEqual({ src: "data:image/png;base64,AAAA", width: 20 })
  })

  it("内置模板迁移后不变（迁移是幂等的）", () => {
    for (const t of builtinTemplates()) expect(deepEqual(migrateJob(t.job), t.job)).toBe(true)
  })
})

describe("模板导入导出", () => {
  it("导出默认去除私有密钥并加标记", () => {
    const t = userTemplate((x) => (x.job.blind.key = "my-secret"))
    const file = JSON.parse(serializeTemplates([t]))
    expect(file.format).toBe("veilmark.templates/v1")
    expect(file.templates[0].job.blind.key).toBe("")
    expect(file.templates[0].privateKeyStripped).toBe(true)
    expect(serializeTemplates([t])).not.toContain("my-secret")
  })

  it("勾选包含私有密钥时保留", () => {
    const t = userTemplate((x) => (x.job.blind.key = "my-secret"))
    const file = JSON.parse(serializeTemplates([t], { includePrivateKey: true }))
    expect(file.templates[0].job.blind.key).toBe("my-secret")
    expect(file.templates[0].privateKeyStripped).toBeUndefined()
  })

  it("公开密钥不算私钥，不加标记", () => {
    const file = JSON.parse(serializeTemplates([userTemplate()]))
    expect(file.templates[0].job.blind.key).toBe(DEFAULT_KEY)
    expect(file.templates[0].privateKeyStripped).toBeUndefined()
  })

  it("导入后再导出，与原文件逐字节一致", () => {
    const templates = [
      userTemplate((x) => (x.job.blind.key = "my-secret")),
      userTemplate((x) => {
        x.id = "tpl-2"
        delete x.description
        x.job.visible[0].text.fill = { type: "linear", angle: 30, stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }] }
        x.job.visible.push({ ...x.job.visible[0], id: "logo", kind: "image", image: { src: "data:image/png;base64,AAAA", width: 12 } })
      }),
      ...builtinTemplates(),
    ]
    const original = serializeTemplates(templates)
    const reimported = parseTemplates(original)
    expect(reimported.map((t) => t.id)).toEqual(templates.map((t) => t.id))
    expect(reimported[0].privateKeyStripped).toBe(true)
    expect(serializeTemplates(reimported)).toBe(original)
  })

  it("接受单个模板对象，缺字段自动补齐", () => {
    const [t] = parseTemplates(JSON.stringify({ name: "手写", job: { author: "A" } }))
    expect(t.name).toBe("手写")
    expect(t.job.author).toBe("A")
    expect(t.job.blind.engine).toBe("cdp")
    expect(t.id).toBeTruthy()
  })

  it("无法识别的文件抛错", () => {
    expect(() => parseTemplates(JSON.stringify({ hello: 1 }))).toThrow()
  })
})
