import type { Metadata, Viewport } from "next"
import { Geist_Mono, Inter } from "next/font/google"
import { ThemeProvider } from "@appica/ui-react/providers/theme-provider"
import { TooltipProvider } from "@appica/ui-react/tooltip"

import "./globals.css"
import { cn } from "@/lib/utils"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

export const metadata: Metadata = {
  title: "Veilmark · 图片版权水印工坊",
  description: "显性水印、伪隐性防盗水印与盲水印，一站式在浏览器本地完成，图片不上传。",
}

// viewport-fit=cover：全屏工作台自己用 safe-area-inset 避让刘海与 Home 指示条
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={cn("antialiased", fontMono.variable, inter.variable)}>
      <body>
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
