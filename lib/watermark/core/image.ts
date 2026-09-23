/**
 * 与框架无关的像素基础设施：浮点通道平面、RGBA 缓冲、可分离重采样。
 * 所有算法模块都只依赖这里，因此可以原样运行在主线程、Web Worker 和 Node（测试）中。
 */

/** 单通道浮点平面（0–255 标度），行优先存储 */
export interface Plane {
  width: number
  height: number
  data: Float32Array
}

/** 与 ImageData 同构的 RGBA 缓冲，Node 测试中无需 DOM 即可构造 */
export interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export function createPlane(width: number, height: number, fill = 0): Plane {
  const data = new Float32Array(width * height)
  if (fill !== 0) data.fill(fill)
  return { width, height, data }
}

export function clonePlane(p: Plane): Plane {
  return { width: p.width, height: p.height, data: new Float32Array(p.data) }
}

export function cloneRGBA(img: RGBAImage): RGBAImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}

/** BT.601 亮度（与 JPEG 的 YCbCr 一致，保证盲水印嵌在压缩器最珍惜的通道上） */
export function lumaPlane(img: RGBAImage): Plane {
  const { width, height, data } = img
  const out = createPlane(width, height)
  const y = out.data
  for (let i = 0, p = 0; p < y.length; i += 4, p++) {
    y[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return out
}

/**
 * 把亮度残差加回 RGB。R/G/B 同加 ΔY 时 BT.601 亮度恰好变化 ΔY，色度不变。
 * 通道饱和时把被截断的部分分摊到其它通道，尽量保住目标亮度。
 */
export function addLumaResidual(img: RGBAImage, residual: Plane): void {
  const { data } = img
  const r = residual.data
  for (let i = 0, p = 0; p < r.length; i += 4, p++) {
    const d = r[p]
    if (d === 0) continue
    let R = data[i] + d
    let G = data[i + 1] + d
    let B = data[i + 2] + d
    // 截断补偿：一次再分配即可覆盖绝大多数高光/暗部像素
    const lost =
      0.299 * (R - clamp255(R)) + 0.587 * (G - clamp255(G)) + 0.114 * (B - clamp255(B))
    R = clamp255(R)
    G = clamp255(G)
    B = clamp255(B)
    if (lost !== 0) {
      const room =
        lost > 0
          ? 0.299 * (255 - R) + 0.587 * (255 - G) + 0.114 * (255 - B)
          : 0.299 * R + 0.587 * G + 0.114 * B
      if (room > 1e-3) {
        const k = Math.min(1, Math.abs(lost) / room)
        if (lost > 0) {
          R += (255 - R) * k
          G += (255 - G) * k
          B += (255 - B) * k
        } else {
          R -= R * k
          G -= G * k
          B -= B * k
        }
      }
    }
    data[i] = R
    data[i + 1] = G
    data[i + 2] = B
  }
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/* ------------------------------------------------------------------------ */
/* 可分离重采样：三角核 + 按缩放比例扩展支撑域（等价 PIL BILINEAR 抗锯齿）     */
/* 下采样时是面积平均，上采样时退化为双线性，保证嵌入端与检测端的尺度模型一致。 */
/* ------------------------------------------------------------------------ */

interface Taps {
  start: Int32Array
  count: Int32Array
  weights: Float32Array
  stride: number
}

function computeTaps(srcSize: number, dstSize: number): Taps {
  const scale = srcSize / dstSize
  const support = Math.max(scale, 1)
  const stride = Math.ceil(support) * 2 + 1
  const start = new Int32Array(dstSize)
  const count = new Int32Array(dstSize)
  const weights = new Float32Array(dstSize * stride)
  for (let o = 0; o < dstSize; o++) {
    const center = (o + 0.5) * scale
    const lo = Math.max(0, Math.floor(center - support))
    const hi = Math.min(srcSize, Math.ceil(center + support))
    let sum = 0
    let n = 0
    for (let s = lo; s < hi && n < stride; s++, n++) {
      const w = Math.max(0, 1 - Math.abs((s + 0.5 - center) / support))
      weights[o * stride + n] = w
      sum += w
    }
    if (sum > 0) for (let k = 0; k < n; k++) weights[o * stride + k] /= sum
    start[o] = lo
    count[o] = n
  }
  return { start, count, weights, stride }
}

export function resizePlane(src: Plane, width: number, height: number): Plane {
  if (src.width === width && src.height === height) return clonePlane(src)
  // 先水平后垂直
  const tx = computeTaps(src.width, width)
  const tmp = new Float32Array(width * src.height)
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width
    for (let x = 0; x < width; x++) {
      const s0 = tx.start[x]
      const n = tx.count[x]
      const wo = x * tx.stride
      let acc = 0
      for (let k = 0; k < n; k++) acc += src.data[row + s0 + k] * tx.weights[wo + k]
      tmp[y * width + x] = acc
    }
  }
  const ty = computeTaps(src.height, height)
  const out = createPlane(width, height)
  for (let y = 0; y < height; y++) {
    const s0 = ty.start[y]
    const n = ty.count[y]
    const wo = y * ty.stride
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = 0; k < n; k++) acc += tmp[(s0 + k) * width + x] * ty.weights[wo + k]
      out.data[y * width + x] = acc
    }
  }
  return out
}

/** RGBA 整体重采样（用于测试中的攻击模拟与缩略图） */
export function resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage {
  const planes = [0, 1, 2, 3].map((c) => {
    const p = createPlane(img.width, img.height)
    for (let i = 0; i < p.data.length; i++) p.data[i] = img.data[i * 4 + c]
    return resizePlane(p, width, height)
  })
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = planes[0].data[i]
    out[i * 4 + 1] = planes[1].data[i]
    out[i * 4 + 2] = planes[2].data[i]
    out[i * 4 + 3] = planes[3].data[i]
  }
  return { width, height, data: out }
}

/** 以长边为基准计算规范化尺寸（保持宽高比） */
export function canonicalDims(width: number, height: number, longSide: number) {
  const s = longSide / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * s)),
    height: Math.max(1, Math.round(height * s)),
  }
}

/** 峰值信噪比，用于在 UI 中量化“画质影响” */
export function psnr(a: RGBAImage, b: RGBAImage): number {
  let se = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c]
      se += d * d
      n++
    }
  }
  const mse = se / n
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}
