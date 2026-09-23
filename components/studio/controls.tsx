"use client"

import { ColorPicker } from "@appica/ui-react/color-picker"
import { formatColor } from "@appica/ui-react/color"
import { Slider } from "@appica/ui-react/slider"
import { Switch } from "@appica/ui-react/switch"
import { Toggle } from "@appica/ui-react/toggle"
import { ToggleGroup } from "@appica/ui-react/toggle-group"

import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { LiveKind } from "@/lib/watermark/live"

/** 面板里反复出现的“标签 + 控件 + 数值”行，统一节奏与对齐 */

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-3 border-b border-border-muted px-4 py-4 last:border-b-0", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground-intense">{title}</h3>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

/** 结束拖动：Base UI 的 onValueCommitted 与全局 pointerup 双保险（指针可能在滑杆外松开） */
function endInteraction() {
  useStudio.getState().setInteracting(null)
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
  disabled,
  live,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
  /** 拖动时由哪种实时预览接管画布；不传则维持“防抖 + CPU” */
  live?: LiveKind
}) {
  return (
    <div className={cn("grid grid-cols-[5.5rem_1fr_3.25rem] items-center gap-3", disabled && "opacity-50")}>
      <span className="truncate text-xs text-foreground-muted">{label}</span>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        tooltipVisibility="never"
        thumbAriaLabel={label}
        onPointerDown={
          live && !disabled
            ? () => {
                useStudio.getState().setInteracting(live)
                window.addEventListener("pointerup", endInteraction, { once: true })
                window.addEventListener("pointercancel", endInteraction, { once: true })
              }
            : undefined
        }
        onValueCommitted={live ? endInteraction : undefined}
        onValueChange={(v) => onChange(typeof v === "number" ? v : v[0])}
      />
      <span className="text-right font-mono text-xs tabular-nums text-foreground-strong">{format(value)}</span>
    </div>
  )
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground-strong">{label}</span>
        {hint && <span className="block text-xs text-foreground-muted">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T
  options: Array<{ value: T; label: React.ReactNode; title?: string }>
  onChange: (v: T) => void
  className?: string
  size?: "sm" | "md"
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => v[0] && onChange(v[0] as T)}
      className={cn("w-full gap-0.5 rounded-lg bg-background-muted p-0.5", className)}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          title={o.title}
          className={cn(
            "flex-1 rounded-md px-2 whitespace-nowrap text-foreground-muted transition-colors outline-ring-primary hover:text-foreground-strong",
            "data-pressed:bg-background data-pressed:text-foreground-intense data-pressed:shadow-xs",
            size === "sm" ? "h-7 text-xs" : "h-8 text-sm"
          )}
        >
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}

export function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      <ColorPicker
        value={value}
        alpha
        size="sm"
        variant="outline"
        onValueChange={(c) => onChange(formatColor(c, "rgba"))}
      />
    </div>
  )
}

export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      {children}
    </div>
  )
}

export function Callout({ tone = "info", children }: { tone?: "info" | "warning"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2.5 text-xs leading-relaxed",
        tone === "info" ? "bg-info-subtle text-foreground-strong" : "bg-warning-subtle text-foreground-strong"
      )}
    >
      {children}
    </div>
  )
}
