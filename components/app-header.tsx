"use client"

import { useTheme } from "@appica/ui-react/hooks/use-theme"
import { Moon, ShieldCheck, Sun } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "工作台" },
  { href: "/verify", label: "验证与注册表" },
]

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const path = usePathname()
  const { resolvedTheme, setTheme, mounted } = useTheme()
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 sm:gap-6">
      <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-foreground-intense">
        <ShieldCheck className="size-4" />
        Veilmark
      </Link>
      <nav className="flex items-center gap-1">
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
      <div className="ml-auto flex items-center gap-3">
        {children}
        <button
          aria-label="切换明暗主题"
          className="rounded-md p-1.5 text-foreground-muted hover:bg-background-muted hover:text-foreground-intense"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {mounted && resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </header>
  )
}
