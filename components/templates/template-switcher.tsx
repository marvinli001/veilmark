"use client"

import { buttonVariants } from "@appica/ui-react/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu"
import { ChevronDown, CopyPlus, LayoutTemplate, Save, Settings2 } from "lucide-react"
import { useState } from "react"

import { isDirty, useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"

import { NameDialog, UnsavedConfirm, type PendingAction } from "./template-dialogs"
import { TemplateManager } from "./template-manager"

/**
 * 顶栏模板切换器。所有“会替换当前参数”的入口（切换、新建）都经过 guard：
 * 有未保存修改时先确认，用户模板还可以“保存并继续”。
 */
export function TemplateSwitcher() {
  const templates = useStudio((s) => s.templates)
  const activeTemplateId = useStudio((s) => s.activeTemplateId)
  const defaultTemplateId = useStudio((s) => s.defaultTemplateId)
  const dirty = useStudio(isDirty)
  const { applyTemplate, saveTemplate, saveAsTemplate, createTemplate } = useStudio.getState()

  const [pending, setPending] = useState<PendingAction | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const active = templates.find((t) => t.id === activeTemplateId)
  const canSave = !!active && !active.builtin
  const builtins = templates.filter((t) => t.builtin)
  const mine = templates.filter((t) => !t.builtin)

  function guard(title: string, run: () => void | Promise<void>) {
    if (!dirty) return void run()
    setPending({
      title,
      description: `「${active?.name ?? "默认配置"}」有未保存的修改，继续将丢弃这些修改。`,
      run,
      save: canSave ? saveTemplate : undefined,
    })
  }

  const requestApply = (id: string) => {
    if (id === activeTemplateId && !dirty) return
    const t = templates.find((x) => x.id === id)
    guard(`切换到「${t?.name ?? "模板"}」？`, () => applyTemplate(id))
  }
  const requestCreate = (name: string) => guard(`新建模板「${name}」？`, () => createTemplate(name).then(() => {}))

  return (
    <>
      <DropdownMenu size="sm">
        <DropdownMenuTrigger
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-w-56 gap-1.5 px-2")}
          aria-label="切换模板"
        >
          <LayoutTemplate className="size-3.5 shrink-0 text-foreground-muted" />
          <span className="truncate">{active?.name ?? "默认配置"}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning-emphasis" title="有未保存的修改" />}
          <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuRadioGroup value={activeTemplateId ?? ""} onValueChange={(v) => requestApply(String(v))}>
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>起步模板 · 只读</DropdownMenuGroupLabel>
              {builtins.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick>
                  {t.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>我的模板</DropdownMenuGroupLabel>
              {mine.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick>
                  <span className="truncate">{t.name}</span>
                  {t.id === defaultTemplateId && <span className="text-xs text-foreground-subtle">默认</span>}
                </DropdownMenuRadioItem>
              ))}
              {!mine.length && <p className="px-2.5 pb-1 text-xs text-foreground-subtle">还没有，另存为即可创建</p>}
            </DropdownMenuGroup>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canSave || !dirty} onClick={() => saveTemplate()}>
            <Save className="size-3.5" /> 保存修改
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setSaveAsOpen(true)}>
            <CopyPlus className="size-3.5" /> 另存为新模板…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setManageOpen(true)}>
            <Settings2 className="size-3.5" /> 管理模板…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NameDialog
        open={saveAsOpen}
        title="另存为新模板"
        confirmLabel="保存"
        initialName={active ? `${active.name}${active.builtin ? "（我的）" : " 副本"}` : "我的模板"}
        onClose={() => setSaveAsOpen(false)}
        onSubmit={async (name, description) => {
          await saveAsTemplate(name, description)
        }}
      />
      <TemplateManager
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onApply={requestApply}
        onCreate={requestCreate}
      />
      <UnsavedConfirm pending={pending} onClose={() => setPending(null)} />
    </>
  )
}
