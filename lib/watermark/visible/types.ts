/**
 * 显性水印配置。所有尺寸都相对图片“短边”表达（百分比 / em），
 * 这样同一套模板批量套到不同分辨率的图上，视觉比例保持一致。
 */

export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "exclusion"
  | "color-dodge"
  | "color-burn"
  | "luminosity"

export type Anchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right"

export type Fill =
  | { type: "solid"; color: string }
  | { type: "linear"; angle: number; stops: Array<{ offset: number; color: string }> }

export interface TextStyle {
  /** 支持多行与模板变量：{author} {date} {time} {filename} {index} {width} {height} {id} */
  content: string
  fontFamily: string
  fontWeight: number
  italic: boolean
  /** 字号 = 短边 × fontSize% */
  fontSize: number
  /** 字间距（em） */
  letterSpacing: number
  lineHeight: number
  align: "left" | "center" | "right"
  uppercase: boolean
  fill: Fill
  stroke: { enabled: boolean; color: string; width: number } // width: em
  shadow: { enabled: boolean; color: string; blur: number; offsetX: number; offsetY: number } // em
  background: { enabled: boolean; color: string; paddingX: number; paddingY: number; radius: number } // em
}

export interface ImageStampStyle {
  /** 已解码的位图由调用方注入（ImageBitmap / OffscreenCanvas），配置里只存来源 */
  src: string
  /** 宽度 = 短边 × width% */
  width: number
}

export type LayoutMode = "single" | "tile" | "band"

export interface LayoutSpec {
  mode: LayoutMode
  /** single 模式的锚点；"smart" 表示自动挑选纹理最少、最不遮挡主体的位置 */
  anchor: Anchor | "smart"
  /** 边距 / 偏移（短边 %） */
  margin: number
  offsetX: number
  offsetY: number
  /** 旋转角（度），tile/band 下为整体网格方向 */
  rotation: number
  /** 平铺间距 = 元素尺寸 × gap（“密度”滑杆映射到这里） */
  gapX: number
  gapY: number
  /** 隔行错位比例 0–1（砖墙式排布） */
  stagger: number
}

export interface VisibleLayer {
  id: string
  name: string
  enabled: boolean
  kind: "text" | "image"
  text: TextStyle
  image?: ImageStampStyle
  layout: LayoutSpec
  opacity: number
  blend: BlendMode
  /** 单点模式下根据背景亮度自动切换黑/白，保证可读 */
  autoContrast: boolean
}

export interface TemplateContext {
  author?: string
  filename?: string
  index?: number
  width?: number
  height?: number
  date?: Date
  /** 盲水印指纹等业务 ID */
  id?: string
}

export const defaultTextStyle = (): TextStyle => ({
  content: "© {author}",
  fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  fontWeight: 600,
  italic: false,
  fontSize: 4,
  letterSpacing: 0.02,
  lineHeight: 1.2,
  align: "center",
  uppercase: false,
  fill: { type: "solid", color: "#ffffff" },
  stroke: { enabled: false, color: "#000000", width: 0.04 },
  shadow: { enabled: true, color: "rgba(0,0,0,0.35)", blur: 0.15, offsetX: 0, offsetY: 0.04 },
  background: { enabled: false, color: "rgba(0,0,0,0.35)", paddingX: 0.5, paddingY: 0.25, radius: 0.3 },
})

export const defaultLayer = (id = crypto.randomUUID()): VisibleLayer => ({
  id,
  name: "文字水印",
  enabled: true,
  kind: "text",
  text: defaultTextStyle(),
  layout: {
    mode: "tile",
    anchor: "bottom-right",
    margin: 3,
    offsetX: 0,
    offsetY: 0,
    rotation: -30,
    gapX: 1.2,
    gapY: 2.5,
    stagger: 0.5,
  },
  opacity: 0.22,
  blend: "source-over",
  autoContrast: false,
})
