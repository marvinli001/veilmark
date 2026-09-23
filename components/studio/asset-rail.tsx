"use client"

import { Checkbox } from "@appica/ui-react/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu"
import { ScrollArea } from "@appica/ui-react/scroll-area"
import { ChevronDown, ImagePlus, Loader2, Trash2, TriangleAlert } from "lucide-react"
import { useRef } from "react"

import { useStudio, type Asset } from "@/lib/store"
import { cn } from "@/lib/utils"

const FOLLOW = "__follow__"

/** 按图指定模板：批量导出时每张图用自己的模板；默认跟随当前正在编辑的参数 */
function AssetTemplatePicker({ asset }: { asset: Asset }) {
  const templates = useStudio((s) => s.templates)
  const setAssetTemplate = useStudio((s) => s.setAssetTemplate)
  const pinned = templates.find((t) => t.id === asset.templateId)
  return (
    <DropdownMenu size="sm">
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex max-w-full items-center gap-0.5 rounded px-1 -mx-1 text-[11px] outline-ring-primary hover:bg-background-muted",
          pinned ? "text-foreground-strong" : "text-foreground-subtle"
        )}
        aria-label={`${asset.name} 使用的模板`}
      >
        <span className="truncate">{pinned ? pinned.name : "跟随当前"}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <DropdownMenuRadioGroup
          value={asset.templateId ?? FOLLOW}
          onValueChange={(v) => setAssetTemplate(asset.id, v === FOLLOW ? undefined : String(v))}
        >
          <DropdownMenuRadioItem value={FOLLOW} closeOnClick>跟随当前参数</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuGroupLabel>起步模板</DropdownMenuGroupLabel>
            {templates
              .filter((t) => t.builtin)
              .map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick>
                  {t.name}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuGroup>
          {templates.some((t) => !t.builtin) && (
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>我的模板</DropdownMenuGroupLabel>
              {templates
                .filter((t) => !t.builtin)
                .map((t) => (
                  <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick>
                    <span className="truncate">{t.name}</span>
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuGroup>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AssetRail() {
  const { assets, activeId, addFiles, setActive, toggleSelected, removeAsset, selectAll } = useStudio()
  const input = useRef<HTMLInputElement>(null)
  const selected = assets.filter((a) => a.selected).length

  return (
    <aside className="flex max-h-64 min-h-0 flex-col border-b border-border bg-background-subtle lg:max-h-none lg:border-r lg:border-b-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-xs font-medium text-foreground-muted">
          素材 {assets.length > 0 && <span className="tabular-nums">· 已选 {selected}/{assets.length}</span>}
        </span>
        {assets.length > 1 && (
          <button
            className="text-xs text-foreground-muted hover:text-foreground-intense"
            onClick={() => selectAll(selected !== assets.length)}
          >
            {selected === assets.length ? "取消全选" : "全选"}
          </button>
        )}
      </div>

      <button
        onClick={() => input.current?.click()}
        className="mx-4 mb-3 flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border-strong text-foreground-muted transition-colors hover:border-border-emphasis hover:bg-background hover:text-foreground-strong"
      >
        <ImagePlus className="size-5" />
        <span className="text-xs">拖拽 / 粘贴 / 点击上传</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ""
        }}
      />

      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1 px-2 pb-4">
          {assets.map((a) => (
            <li key={a.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setActive(a.id)}
                onKeyDown={(e) => e.key === "Enter" && setActive(a.id)}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg p-2 text-left outline-ring-primary",
                  a.id === activeId ? "bg-background shadow-xs" : "hover:bg-background-muted"
                )}
              >
                <Checkbox
                  checked={a.selected}
                  onCheckedChange={(v) => toggleSelected(a.id, v)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`选择 ${a.name}`}
                />
                <div className="checkerboard relative size-10 shrink-0 overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 本地 blob URL，无需 next/image 优化 */}
                  <img src={a.result?.url ?? a.url} alt="" className="size-full object-cover" />
                  {a.status === "processing" && (
                    <span className="absolute inset-0 grid place-items-center bg-background/60">
                      <Loader2 className="size-4 animate-spin" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-foreground-intense">{a.name}</p>
                  <p className="flex items-center gap-1 text-[11px] text-foreground-muted tabular-nums">
                    {a.status === "error" && <TriangleAlert className="size-3 text-error-emphasis" />}
                    {a.width}×{a.height}
                  </p>
                  <AssetTemplatePicker asset={a} />
                </div>
                <button
                  aria-label="移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAsset(a.id)
                  }}
                  className="rounded p-1 text-foreground-subtle opacity-0 group-hover:opacity-100 hover:text-error-emphasis focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </aside>
  )
}
