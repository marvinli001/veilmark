"use client"

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
import { Check, Ellipsis, LayoutTemplate, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react"
import { useEffect, useRef } from "react"

import { useStudio, type Asset } from "@/lib/store"
import { cn } from "@/lib/utils"

const FOLLOW = "__follow__"
const ACCEPT = "image/png,image/jpeg,image/webp"

/** 打开系统文件选择（iOS 会把 HEIC 转成 JPEG 交给页面）。input 常驻 body，避免游离节点在 Safari 上收不到 change */
let picker: HTMLInputElement | null = null
export function pickImages() {
  if (!picker) {
    picker = document.createElement("input")
    picker.type = "file"
    picker.accept = ACCEPT
    picker.multiple = true
    picker.hidden = true
    picker.addEventListener("change", () => {
      useStudio.getState().addFiles(Array.from(picker!.files ?? []))
      picker!.value = ""
    })
    document.body.append(picker)
  }
  picker.click()
}

/** 单张图的操作：指定模板（批量导出时每张图用自己的模板，默认跟随当前参数）、移除 */
function AssetMenu({ asset }: { asset: Asset }) {
  const templates = useStudio((s) => s.templates)
  const setAssetTemplate = useStudio((s) => s.setAssetTemplate)
  const removeAsset = useStudio((s) => s.removeAsset)
  return (
    <DropdownMenu size="sm">
      <DropdownMenuTrigger
        aria-label={`${asset.name} 的操作`}
        className="absolute -top-1.5 -right-1.5 z-10 grid size-6 place-items-center rounded-full border border-border bg-background text-foreground-strong shadow-sm outline-ring-primary hover:text-foreground-intense"
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>
            <span className="block truncate">{asset.name}</span>
            <span className="font-normal tabular-nums">
              {asset.width}×{asset.height}
            </span>
          </DropdownMenuGroupLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={asset.templateId ?? FOLLOW}
          onValueChange={(v) => setAssetTemplate(asset.id, v === FOLLOW ? undefined : String(v))}
        >
          <DropdownMenuGroup>
            <DropdownMenuGroupLabel>此图使用的模板</DropdownMenuGroupLabel>
            <DropdownMenuRadioItem value={FOLLOW} closeOnClick>
              跟随当前参数
            </DropdownMenuRadioItem>
            {templates.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick>
                <span className="truncate">{t.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-error-emphasis" onClick={() => removeAsset(asset.id)}>
          <Trash2 className="size-3.5" /> 移除这张图
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 画布下方的缩略图条：点缩略图切换预览，左上角圆钮勾选参与批量导出，当前图右上角是操作菜单。
 * 横向滚动，手机、iPad、桌面共用一套交互（不依赖悬停）。
 */
export function AssetStrip() {
  const { assets, activeId, setActive, toggleSelected, selectAll } = useStudio()
  const templates = useStudio((s) => s.templates)
  const selected = assets.filter((a) => a.selected).length
  const list = useRef<HTMLUListElement>(null)

  // 切换当前图时把它滚进可视区（批量添加后当前图可能在屏幕外）
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-id="${activeId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeId])

  if (!assets.length) return null

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border py-2 pr-3 pl-1.5 md:pl-2.5 short:py-1">
      <ul ref={list} className="scrollbar-none -my-2 flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto py-2.5 pr-2 pl-2.5">
        {assets.map((a) => {
          const active = a.id === activeId
          const pinned = a.templateId ? templates.find((t) => t.id === a.templateId) : undefined
          return (
            <li key={a.id} data-id={a.id} className="relative shrink-0">
              <button
                onClick={() => setActive(a.id)}
                title={`${a.name} · ${a.width}×${a.height}${pinned ? ` · 模板「${pinned.name}」` : ""}`}
                aria-label={a.name}
                aria-current={active}
                className={cn(
                  "checkerboard relative block size-12 overflow-hidden rounded-lg outline-ring-primary transition-shadow md:size-14 short:size-10",
                  active && "ring-2 ring-foreground-intense ring-offset-2 ring-offset-background",
                  // 未勾选的图淡出，一眼看出哪些不参与批量导出
                  !a.selected ? "opacity-45" : !active && "opacity-85 hover:opacity-100"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- 本地 blob URL，无需 next/image 优化 */}
                <img src={a.result?.url ?? a.url} alt="" className="size-full object-cover" draggable={false} />
                {a.status === "processing" && (
                  <span className="absolute inset-0 grid place-items-center bg-background/60">
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                )}
                {a.status === "error" && (
                  <span className="absolute inset-0 grid place-items-center bg-error-subtle/80">
                    <TriangleAlert className="size-4 text-error-emphasis" />
                  </span>
                )}
                {pinned && (
                  <span className="absolute right-0.5 bottom-0.5 grid size-4 place-items-center rounded bg-background/90 text-foreground-strong">
                    <LayoutTemplate className="size-2.5" />
                  </span>
                )}
              </button>
              {/* 勾选框：比视觉尺寸大一圈的点击区，手指也点得准 */}
              <button
                role="checkbox"
                aria-checked={a.selected}
                aria-label={`批量导出时包含 ${a.name}`}
                onClick={() => toggleSelected(a.id)}
                className="absolute -top-2 -left-2 z-10 grid size-6 place-items-center rounded-full outline-ring-primary"
              >
                <span
                  className={cn(
                    "grid size-4 place-items-center rounded-full border shadow-xs",
                    a.selected
                      ? "border-transparent bg-foreground-intense text-background"
                      : "border-border-strong bg-background text-transparent"
                  )}
                >
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              </button>
              {active && <AssetMenu asset={a} />}
            </li>
          )
        })}
        <li className="shrink-0">
          <button
            onClick={pickImages}
            aria-label="添加图片"
            className="grid size-12 place-items-center rounded-lg border border-dashed border-border-strong text-foreground-muted outline-ring-primary hover:border-border-emphasis hover:text-foreground-intense md:size-14 short:size-10"
          >
            <Plus className="size-5" />
          </button>
        </li>
      </ul>
      {assets.length > 1 && (
        <button
          className="shrink-0 rounded-md px-2 py-1 text-xs text-foreground-muted tabular-nums outline-ring-primary hover:bg-background-muted hover:text-foreground-intense"
          onClick={() => selectAll(selected !== assets.length)}
        >
          已选 {selected}/{assets.length}
          <span className="block text-[11px] text-foreground-subtle">{selected === assets.length ? "取消全选" : "全选"}</span>
        </button>
      )}
    </div>
  )
}
