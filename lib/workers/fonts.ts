/**
 * Worker 里的 OffscreenCanvas 只能用系统字体，看不到页面通过 @font-face 加载的网络字体
 * （例如 next/font 自托管的 Inter）。结果是同一个字体栈在主线程命中 Inter、在 Worker 里退到苹方，
 * 导出图与主线程的实时预览字形不一致（实测同一行字宽 336px vs 320px）。
 * 这里把页面的 @font-face 声明收集出来，交给每个 Worker 用 FontFace 注册一遍。
 */

export interface FontSpec {
  family: string
  url: string
  descriptors: FontFaceDescriptors
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "")

export function collectDocumentFonts(): FontSpec[] {
  if (typeof document === "undefined") return []
  const out: FontSpec[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 跨域样式表不可读，跳过
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const st = rule.style
      const family = unquote(st.getPropertyValue("font-family"))
      const src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(st.getPropertyValue("src"))
      if (!family || !src) continue // 只有 local() 的回退字体（如 "Inter Fallback"）不需要搬
      const descriptors: FontFaceDescriptors = {}
      const weight = st.getPropertyValue("font-weight")
      const style = st.getPropertyValue("font-style")
      const range = st.getPropertyValue("unicode-range")
      if (weight) descriptors.weight = weight
      if (style) descriptors.style = style
      if (range) descriptors.unicodeRange = range
      out.push({ family, url: new URL(src[1], sheet.href ?? location.href).href, descriptors })
    }
  }
  return out
}

/** Worker 侧：注册并等待字体加载完成。单个字体失败不影响其它字体 */
export async function registerFonts(specs: FontSpec[]) {
  const fonts = (globalThis as unknown as { fonts?: FontFaceSet }).fonts
  if (!fonts || typeof FontFace === "undefined") return 0
  const loaded = await Promise.all(
    specs.map(async (f) => {
      try {
        const face = new FontFace(f.family, `url(${f.url})`, f.descriptors)
        await face.load()
        fonts.add(face)
        return 1
      } catch {
        return 0
      }
    })
  )
  return loaded.reduce<number>((a, b) => a + b, 0)
}
