"use client"

import { useTheme } from "@appica/ui-react/hooks/use-theme"
import { Popover, PopoverContent, PopoverTrigger } from "@appica/ui-react/popover"
import { Ellipsis, Moon, ShieldCheck, Sun } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "工作台" },
  { href: "/verify", label: "验证与注册表" },
]

function ThemeButton() {
  const { resolvedTheme, setTheme, mounted } = useTheme()
  return (
    <button
      aria-label="切换明暗主题"
      className="grid size-8 place-items-center rounded-md text-foreground-muted hover:bg-background-muted hover:text-foreground-intense"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}

/**
 * 顶栏。children 始终显示（如模板切换）；extra 在宽屏内联显示，窄屏收进“更多”弹层（如署名输入），
 * 导航与主题切换在窄屏同样收进弹层，保证 375px 宽的手机上不溢出。
 */
export function AppHeader({ children, extra }: { children?: React.ReactNode; extra?: React.ReactNode }) {
  const path = usePathname()
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 pt-[env(safe-area-inset-top)] box-content md:gap-6 md:pr-4">
      <Link href="/" className="flex shrink-0 items-center gap-2 text-sm font-semibold text-foreground-intense">
        <ShieldCheck className="size-4" />
        <span className="max-[359px]:sr-only">Veilmark</span>
      </Link>
      <nav className="hidden items-center gap-1 md:flex">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm whitespace-nowrap text-foreground-muted hover:text-foreground-intense",
              path === n.href && "bg-background-muted text-foreground-intense"
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex min-w-0 items-center gap-1 md:gap-3">
        {children}
        {extra && <div className="hidden md:flex">{extra}</div>}
        <div className="hidden md:block">
          <ThemeButton />
        </div>
        <Popover>
          <PopoverTrigger
            aria-label="更多"
            className="grid size-9 shrink-0 place-items-center rounded-md text-foreground-muted outline-ring-primary hover:bg-background-muted hover:text-foreground-intense md:hidden"
          >
            <Ellipsis className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" arrow={false} className="flex w-72 flex-col gap-3 p-3">
            {extra}
            <nav className="flex flex-col">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "rounded-md px-2.5 py-2 text-sm text-foreground-strong hover:bg-background-muted",
                    path === n.href && "bg-background-muted text-foreground-intense"
                  )}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="flex items-center justify-between border-t border-border-muted pt-2 pl-2.5 text-sm text-foreground-strong">
              明暗主题
              <ThemeButton />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
