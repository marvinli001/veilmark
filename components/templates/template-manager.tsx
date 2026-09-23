"use client"

import { Badge } from "@appica/ui-react/badge"
import { Button, buttonVariants } from "@appica/ui-react/button"
import { Checkbox } from "@appica/ui-react/checkbox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu"
import { Copy, Download, Ellipsis, FilePlus2, Pencil, Star, StarOff, Trash2, Upload } from "lucide-react"
import { useRef, useState } from "react"

import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { hasPrivateKey, type Template } from "@/lib/watermark/templates"

import { DangerConfirm, NameDialog } from "./template-dialogs"

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_")

/** 模板的一句话摘要：启用了哪些水印、用什么引擎 */
function summary(t: Template) {
  const j = t.job
  const parts: string[] = []
  const layers = j.visible.filter((l) => l.enabled)
  if (layers.length) parts.push(`显性 ${layers.length} 层`)
  if (j.glance.enabled) parts.push(`伪隐性·${{ daily: "日常隐藏", print: "打印显形", screenshot: "抗截图", hybrid: "打印+截图", custom: "自定义" }[j.glance.mode]}`)
  if (j.blind.enabled) parts.push(`盲水印·${{ cdp: "CDP", trustmark: "TrustMark", dual: "双引擎" }[j.blind.engine]}`)
  parts.push(j.export.format.toUpperCase())
  return parts.join(" · ")
}

export function TemplateManager({
  open,
  onClose,
  onApply,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onApply: (id: string) => void
  onCreate: (name: string) => void
}) {
  const templates = useStudio((s) => s.templates)
  const activeTemplateId = useStudio((s) => s.activeTemplateId)
  const defaultTemplateId = useStudio((s) => s.defaultTemplateId)
  const { renameTemplate, duplicateTemplate, deleteTemplate, setDefaultTemplate, importTemplates, exportTemplates } =
    useStudio.getState()

  const [includeKey, setIncludeKey] = useState(false)
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [renaming, setRenaming] = useState<Template | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Template | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const mine = templates.filter((t) => !t.builtin)
  const anyPrivate = mine.some((t) => hasPrivateKey(t.job))

  const exportOne = (t: Template) =>
    saveBlob(exportTemplates([t.id], includeKey), `${safeName(t.name)}.veilmark-template.json`)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-170">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-lg">模板管理</DialogTitle>
          <DialogDescription>
            模板保存在本机浏览器（IndexedDB），可导出 JSON 在设备间迁移。起步模板只读，复制后即可修改。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="soft" onClick={() => setCreating(true)}>
              <FilePlus2 className="size-3.5" /> 新建
            </Button>
            <Button size="sm" variant="outline" onClick={() => importInput.current?.click()}>
              <Upload className="size-3.5" /> 导入
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!mine.length}
              onClick={() => saveBlob(exportTemplates("all", includeKey), "veilmark-templates.json")}
            >
              <Download className="size-3.5" /> 导出全部
            </Button>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-foreground-strong">
              <Checkbox checked={includeKey} onCheckedChange={(v) => setIncludeKey(v === true)} />
              导出时包含私有密钥
            </label>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ""
                if (!f) return
                try {
                  const n = await importTemplates(f)
                  setNotice({ tone: "ok", text: `已导入 ${n} 个模板` })
                } catch (err) {
                  setNotice({ tone: "error", text: `导入失败：${err instanceof Error ? err.message : String(err)}` })
                }
              }}
            />
          </div>
          {includeKey && anyPrivate && (
            <p className="rounded-lg bg-warning-subtle px-3 py-2 text-xs text-foreground-strong">
              导出文件将包含私钥明文。持有私钥的人可以检出甚至伪造你的 CDP 指纹，请勿公开分享。
            </p>
          )}
          {notice && (
            <p
              className={cn(
                "rounded-lg px-3 py-2 text-xs text-foreground-strong",
                notice.tone === "ok" ? "bg-success-subtle" : "bg-error-subtle"
              )}
            >
              {notice.text}
            </p>
          )}

          <ul className="-mx-2 flex max-h-[min(26rem,55vh)] flex-col overflow-y-auto">
            {templates.map((t) => {
              const active = t.id === activeTemplateId
              return (
                <li key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-background-subtle">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground-intense">
                      <span className="truncate">{t.name}</span>
                      {t.builtin && (
                        <Badge size="xs" variant="soft">
                          起步
                        </Badge>
                      )}
                      {t.id === defaultTemplateId && (
                        <Badge size="xs" variant="info">
                          默认
                        </Badge>
                      )}
                      {active && (
                        <Badge size="xs" variant="success">
                          当前
                        </Badge>
                      )}
                      {t.privateKeyStripped && !t.job.blind.key && (
                        <Badge size="xs" variant="warning">
                          私钥已去除
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-foreground-muted">{t.description || summary(t)}</p>
                    {t.description && <p className="truncate text-[11px] text-foreground-subtle">{summary(t)}</p>}
                  </div>
                  <Button
                    size="sm"
                    variant={active ? "ghost" : "outline"}
                    disabled={active}
                    onClick={() => {
                      onClose()
                      onApply(t.id)
                    }}
                  >
                    {active ? "使用中" : "应用"}
                  </Button>
                  <DropdownMenu size="sm">
                    <DropdownMenuTrigger
                      className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
                      aria-label={`${t.name} 更多操作`}
                    >
                      <Ellipsis className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {!t.builtin && (
                        <DropdownMenuItem onClick={() => setRenaming(t)}>
                          <Pencil className="size-3.5" /> 重命名
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={async () => {
                          const id = await duplicateTemplate(t.id)
                          setNotice({ tone: "ok", text: `已复制为「${useStudio.getState().templates.find((x) => x.id === id)?.name}」` })
                        }}
                      >
                        <Copy className="size-3.5" /> 复制
                      </DropdownMenuItem>
                      {t.id === defaultTemplateId ? (
                        <DropdownMenuItem onClick={() => setDefaultTemplate(null)}>
                          <StarOff className="size-3.5" /> 取消默认
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => setDefaultTemplate(t.id)}>
                          <Star className="size-3.5" /> 设为默认
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => exportOne(t)}>
                        <Download className="size-3.5" /> 导出 JSON
                      </DropdownMenuItem>
                      {!t.builtin && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-error-emphasis" onClick={() => setDeleting(t)}>
                            <Trash2 className="size-3.5" /> 删除
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-foreground-subtle">默认模板：首次打开（或清空浏览器数据后）自动套用。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            完成
          </Button>
        </DialogFooter>

        <NameDialog
          open={!!renaming}
          title="重命名模板"
          confirmLabel="保存"
          initialName={renaming?.name}
          initialDescription={renaming?.description}
          onClose={() => setRenaming(null)}
          onSubmit={async (name, description) => {
            if (renaming) await renameTemplate(renaming.id, name, description)
          }}
        />
        <NameDialog
          open={creating}
          title="新建空白模板"
          confirmLabel="新建并应用"
          initialName="新模板"
          onClose={() => setCreating(false)}
          onSubmit={(name) => {
            onClose()
            onCreate(name)
          }}
        />
        <DangerConfirm
          open={!!deleting}
          title={`删除「${deleting?.name}」？`}
          description="删除后无法恢复；指定了该模板的图片会改为跟随当前参数。建议先导出备份。"
          confirmLabel="删除"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            if (deleting) await deleteTemplate(deleting.id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
