import { defaultTextStyle, type LayoutSpec, type TextStyle } from "../visible/types"

/**
 * 智能“伪隐性”显性水印（Smart Glance-Proof Watermark）
 *
 * 四个可叠加的“触发层”，每层对应一种盗用场景下的显形机理：
 *
 * | 层            | 编码方式                               | 日常浏览为何看不见                 | 何时显形                                   |
 * | ------------- | -------------------------------------- | ---------------------------------- | ------------------------------------------ |
 * | grating 相位光栅 | 奈奎斯特附近高频栅格，信息区相位反转 180°；亮度 + 等亮度色度两路 | 缩略/适屏显示做面积平均，两区均值相同；色度路在 1:1 下也超出 S 视锥分辨率 | 最近邻/非整数重采样、打印加网采样、锐化       |
 * | pantograph 防复印底纹 | 背景细网点 vs 信息区粗网点，平均亮度相同 | 同上                               | 打印：细网点被加网吞掉并网点扩大变暗，粗网点保留 |
 * | tone 暗部色调 | 信息区 ±ΔY（偏向暗部），纹理自适应       | 低于亮度 JND，且被纹理掩蔽         | 拉对比度、提亮阴影、去雾/清晰度             |
 * | chroma 等亮度色度 | 沿 BT.601 等亮度的蓝–黄轴偏移          | S 视锥空间分辨率与灵敏度最低       | 饱和度/自然饱和度拉高、平均法去色、CMYK 分色 |
 *
 * 高频层（grating/pantograph）必须无损导出（PNG / 无损 WebP），平台二次 JPEG 压缩会抹掉它们；
 * 低频层（tone/chroma）能扛住截图与压缩，但显形依赖“调色”类二次加工。
 *
 * 四层共用一张掩膜（字号、加粗、羽化只有一份）和同一份“日常看不见”的余量，所以预设是单选：
 * 叠加得越多，适屏与 1:1 下越容易露馅。hybrid 是打印与截图的折中配比，见 glancePreset。
 *
 * 显形后能不能“读出来”，除了幅度还取决于字形：低对比度下细笔画（尤其中文）糊成一片，
 * 所以高频预设给掩膜描边加粗（bold）。
 */

export type GlanceMode = "daily" | "print" | "screenshot" | "hybrid" | "custom"

/** auto：避开画面主色所在的轴，防止“拉饱和度”时该通道先被截断吞掉信号 */
export type ChromaAxis = "auto" | "blue-yellow" | "red-green"

export interface GlanceConfig {
  enabled: boolean
  mode: GlanceMode
  /** 信息内容与排版（复用显性水印排版引擎） */
  text: TextStyle
  layout: LayoutSpec
  /** 掩膜羽化半径（短边 ‰）：边界越软，1:1 放大时越难看出字形轮廓 */
  feather: number
  /** 掩膜笔画加粗（每侧描边宽度 / 字号）：显形后低对比度的字形更易读 */
  bold: number
  /**
   * chroma：光栅的等亮度色度分量振幅（蓝–黄轴，B 通道灰阶）。与亮度光栅同载波、同相位反转，
   * 点采样后变成成片的色差；不乘 JND 图（纹理掩蔽按亮度估计，与高频色度的可见性无关）
   */
  grating: { enabled: boolean; amplitude: number; kind: "checker" | "lines"; period: number; angle: number; chroma: number }
  pantograph: { enabled: boolean; amplitude: number; coarsePeriod: number }
  tone: { enabled: boolean; amplitude: number; shadowBias: number }
  chroma: { enabled: boolean; amplitude: number; axis: ChromaAxis }
  /** 纹理自适应（JND 掩蔽）强度 0–1 */
  adaptive: number
}

const baseMaskText = (): TextStyle => ({
  ...defaultTextStyle(),
  content: "© {author}",
  fontWeight: 800,
  fontSize: 9,
  letterSpacing: 0.04,
  shadow: { ...defaultTextStyle().shadow, enabled: false },
})

const baseLayout = (): LayoutSpec => ({
  mode: "tile",
  anchor: "center",
  margin: 0,
  offsetX: 0,
  offsetY: 0,
  rotation: -30,
  gapX: 0.35,
  gapY: 0.9,
  stagger: 0.5,
})

export function glancePreset(mode: Exclude<GlanceMode, "custom">): GlanceConfig {
  const common = {
    enabled: true,
    mode,
    text: baseMaskText(),
    layout: baseLayout(),
    adaptive: 0.8,
  }
  switch (mode) {
    case "daily":
      return {
        ...common,
        feather: 2.5,
        bold: 0,
        grating: { enabled: false, amplitude: 2, kind: "checker", period: 2, angle: 0, chroma: 0 },
        pantograph: { enabled: false, amplitude: 0, coarsePeriod: 6 },
        tone: { enabled: true, amplitude: 1.8, shadowBias: 0.6 },
        chroma: { enabled: true, amplitude: 7, axis: "auto" },
      }
    case "print":
      return {
        ...common,
        feather: 1,
        bold: 0.03,
        adaptive: 0.95,
        grating: { enabled: true, amplitude: 4, kind: "checker", period: 2, angle: 0, chroma: 16 },
        pantograph: { enabled: true, amplitude: 4, coarsePeriod: 5 },
        tone: { enabled: true, amplitude: 1, shadowBias: 0.3 },
        chroma: { enabled: true, amplitude: 3, axis: "auto" },
      }
    case "screenshot":
      return {
        ...common,
        text: { ...baseMaskText(), fontSize: 13 },
        feather: 4,
        bold: 0,
        grating: { enabled: true, amplitude: 3, kind: "lines", period: 3, angle: 45, chroma: 0 },
        pantograph: { enabled: false, amplitude: 0, coarsePeriod: 6 },
        tone: { enabled: true, amplitude: 2.4, shadowBias: 0.5 },
        chroma: { enabled: true, amplitude: 8, axis: "auto" },
      }
    case "hybrid":
      // 打印层原样保留；低频层拉到接近 screenshot，截图后调色仍能显形。
      // 字号与羽化取两者之间：打印要小字硬边，截图要大字软边。
      // 加粗让低频层的实心笔画变多、适屏略更显眼，tone/chroma 相应从 2.2/7.5 降到 2.1/7。
      // 合成图实测：适屏可见度不高于 screenshot，最近邻/打印显形不低于 print（docs/ARCHITECTURE.md 2.3）
      return {
        ...common,
        text: { ...baseMaskText(), fontSize: 11 },
        feather: 2.5,
        bold: 0.03,
        adaptive: 0.9,
        grating: { enabled: true, amplitude: 4, kind: "checker", period: 2, angle: 0, chroma: 16 },
        pantograph: { enabled: true, amplitude: 4, coarsePeriod: 5 },
        tone: { enabled: true, amplitude: 2.1, shadowBias: 0.45 },
        chroma: { enabled: true, amplitude: 7, axis: "auto" },
      }
  }
}

/** 渲染掩膜用的文字样式：加粗通过白色描边实现（掩膜模式下描边与填充同为不透明） */
export function glanceMaskStyle(cfg: GlanceConfig): TextStyle {
  return { ...cfg.text, stroke: { enabled: cfg.bold > 0, color: "#fff", width: cfg.bold } }
}

/**
 * BT.601 等亮度方向：0.299·r + 0.587·g + 0.114·b = 0。
 * blue-yellow：R=G=k, B=−1 → k = 0.114/0.886；red-green：B=0, R=1, G=−0.299/0.587
 */
export const CHROMA_AXES = {
  "blue-yellow": [0.114 / 0.886, 0.114 / 0.886, -1] as const,
  "red-green": [1, -0.299 / 0.587, 0] as const,
}

/**
 * 光栅色度路固定走蓝–黄轴：S 视锥对奈奎斯特附近的色度几乎没有响应，1:1 下也看不出；
 * 它靠重采样显形而不是拉饱和度，不存在低频色度层“主色通道先截断”的问题，无需按主色切轴
 */
export const GRATING_CHROMA_AXIS = CHROMA_AXES["blue-yellow"]

/** 人眼对红–绿等亮度差的敏感度远高于蓝–黄（实测 1:1 下 8 级即出现粉色斑块），切轴时必须降幅 */
export const CHROMA_AXIS_GAIN = { "blue-yellow": 1, "red-green": 0.35 } as const
