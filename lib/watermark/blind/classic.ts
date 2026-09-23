import {
  addLumaResidual,
  canonicalDims,
  createPlane,
  lumaPlane,
  resizePlane,
  type Plane,
  type RGBAImage,
} from "../core/image"
import { deriveSeed, keyedBits, keyedPermutation } from "../core/prng"
import { FRAME_BITS, packFrame, unpackFrame, type BlindPayload } from "./payload"
import {
  N,
  dct8,
  haarLL,
  haarLLInverseDelta,
  idct8,
  readBlock,
  writeBlock,
} from "./transforms"

/**
 * 经典频域盲水印 · Canonical-DWT-DCT 系数对符号调制（CDP）
 *
 * 流程（嵌入）：
 *   Y 通道 → 规范化到长边 C（默认 1024，消除缩放）→ Haar DWT 取 LL
 *   → 8×8 DCT → 每块 3 组“等频率”系数对 (a,c)，按比特强制 sign(a−c) 且 |a−c| ≥ T
 *   → 逆 DCT/逆 DWT 得规范尺度残差 → 双线性放大回原尺寸 → 叠加到 RGB
 *   → 闭环：从真实输出重新测量，补偿放大/取整/截断造成的余量损失（默认 3 轮）
 *
 * 相比 blind_watermark 式 “SVD 最大奇异值 QIM”：
 *   - QIM 量化的是块能量绝对值，亮度 ±2、对比度 ×1.05、Gamma、截图色彩管理都会整体
 *     平移量化格点 → 比特大面积翻转；
 *   - 系数对符号只看 AC 分量的相对大小：亮度偏移（只影响 DC）与增益（同比缩放）
 *     天然免疫，单调色调曲线也基本保号。
 *   - 规范化尺度 + 低频系数让水印在原图上是超低频的缓变纹理，JPEG 8×8 量化几乎碰不到。
 */

export interface ClassicBlindOptions {
  /** 密钥：决定比特打乱与白化序列。公开验证用默认值，私有追踪用自定义值 */
  key: string
  /** 目标余量 T（DCT 系数单位），越大越鲁棒、越可见。默认 5；小图（规范尺度 512）自动 ×1.3 */
  strength?: number
  /** 规范化长边；小图自动降到 512 */
  canonical?: number
  /** 闭环补偿轮数 */
  passes?: number
  /** 纹理掩蔽：纹理区允许更大改动（人眼不敏感），平坦区更克制 */
  adaptive?: boolean
}

export interface ClassicExtractResult {
  found: boolean
  payload: BlindPayload | null
  /** 平均 |z|，未加水印的图约为 0.8，可靠检测通常 > 4 */
  score: number
  /** 软判决与硬判决不一致的槽位占比（原始误码率估计） */
  rawBitErrorRate: number
  canonical: number
  trimmed: boolean
}

/** 同一径向频率的系数对 (u1,v1)↔(u2,v2)，模糊/压缩对两者的衰减近似相同 */
const PAIRS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 2, 2, 1],
  [0, 2, 2, 0],
  [1, 3, 3, 1],
]

export const DEFAULT_KEY = "veilmark-public-v1"
export const CANONICAL_SIZES = [1024, 512] as const

interface Layout {
  cw: number
  ch: number
  bx: number
  by: number
  slots: number
  slotBit: Uint16Array
  whiten: Uint8Array
}

function makeLayout(width: number, height: number, canonical: number, key: string): Layout {
  const { width: cw, height: ch } = canonicalDims(width, height, canonical)
  const bx = Math.floor(cw / 2 / N)
  const by = Math.floor(ch / 2 / N)
  const slots = bx * by * PAIRS.length
  const perm = keyedPermutation(slots, deriveSeed(key, "cdp-perm"))
  const slotBit = new Uint16Array(slots)
  for (let s = 0; s < slots; s++) slotBit[s] = perm[s] % FRAME_BITS
  const whiten = keyedBits(slots, deriveSeed(key, "cdp-whiten"))
  return { cw, ch, bx, by, slots, slotBit, whiten }
}

function pickCanonical(width: number, height: number, requested?: number) {
  if (requested) return requested
  return Math.max(width, height) >= 1024 ? 1024 : 512
}

/** 块纹理活跃度：AC 系数绝对值均值（跳过 DC） */
function blockActivity(c: Float64Array): number {
  let acc = 0
  for (let i = 1; i < 64; i++) acc += Math.abs(c[i])
  return acc / 63
}

export function embedClassic(
  img: RGBAImage,
  payload: BlindPayload,
  opts: ClassicBlindOptions
): RGBAImage {
  const passes = opts.passes ?? 3
  const adaptive = opts.adaptive ?? true
  const canonical = pickCanonical(img.width, img.height, opts.canonical)
  // 小图槽位少、每比特重复次数低，用更大的余量补偿
  const strength = (opts.strength ?? 5) * (canonical <= 512 ? 1.3 : 1)
  const L = makeLayout(img.width, img.height, canonical, opts.key)
  if (L.slots < FRAME_BITS * 8) throw new Error("图像过小，无法可靠嵌入盲水印")

  const frame = packFrame(payload)
  const out: RGBAImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  const block = new Float64Array(64)
  const delta = new Float64Array(64)

  // 每块的余量目标在第一轮根据原图纹理确定，后续轮次沿用，避免闭环中目标漂移
  const targets = new Float32Array(L.bx * L.by)

  for (let pass = 0; pass < passes; pass++) {
    const yc = resizePlane(lumaPlane(out), L.cw, L.ch)
    const ll = haarLL(yc)
    const dLL = createPlane(ll.width, ll.height)
    let touched = 0

    for (let by = 0; by < L.by; by++) {
      for (let bx = 0; bx < L.bx; bx++) {
        const b = by * L.bx + bx
        readBlock(ll, bx, by, block)
        dct8(block)
        if (pass === 0) {
          const mask = adaptive ? Math.min(2, Math.max(1, blockActivity(block) / 6)) : 1
          targets[b] = strength * mask
        }
        const T = targets[b]
        delta.fill(0)
        let changed = false
        for (let p = 0; p < PAIRS.length; p++) {
          const s = b * PAIRS.length + p
          const bit = frame[L.slotBit[s]] ^ L.whiten[s]
          const sign = bit ? 1 : -1
          const [u1, v1, u2, v2] = PAIRS[p]
          const a = block[u1 * N + v1]
          const c = block[u2 * N + v2]
          const margin = sign * (a - c)
          if (margin >= T) continue
          // 双边各推一半；单次改动封顶，宿主强反向时放弃该槽位，交给重复编码
          const need = Math.min((T - margin) / 2, 1.5 * T)
          delta[u1 * N + v1] += sign * need
          delta[u2 * N + v2] -= sign * need
          changed = true
        }
        if (!changed) continue
        touched++
        idct8(delta)
        writeBlock(dLL, bx, by, delta)
      }
    }
    if (touched === 0) break
    const dCanon = haarLLInverseDelta(dLL, L.cw, L.ch)
    const residual = resizePlane(dCanon, img.width, img.height)
    addLumaResidual(out, residual)
  }
  return out
}

/* ------------------------------ 检测 ------------------------------ */

function softDecode(img: RGBAImage, canonical: number, key: string) {
  const L = makeLayout(img.width, img.height, canonical, key)
  if (L.slots < FRAME_BITS * 4) return null
  const ll = haarLL(resizePlane(lumaPlane(img), L.cw, L.ch))
  const sum = new Float64Array(FRAME_BITS)
  const energy = new Float64Array(FRAME_BITS)
  const soft = new Float32Array(L.slots)
  const block = new Float64Array(64)
  const T0 = 7
  for (let by = 0; by < L.by; by++)
    for (let bx = 0; bx < L.bx; bx++) {
      readBlock(ll, bx, by, block)
      dct8(block)
      const b = by * L.bx + bx
      for (let p = 0; p < PAIRS.length; p++) {
        const s = b * PAIRS.length + p
        const [u1, v1, u2, v2] = PAIRS[p]
        // 截幅软判决：抑制强纹理块的宿主干扰主导求和
        let v = (block[u1 * N + v1] - block[u2 * N + v2]) / T0
        v = v > 1.5 ? 1.5 : v < -1.5 ? -1.5 : v
        if (L.whiten[s]) v = -v // 撤销白化：帧比特 = 编码比特 ⊕ 白化比特
        soft[s] = v
        sum[L.slotBit[s]] += v
        energy[L.slotBit[s]] += v * v
      }
    }
  const bits = new Uint8Array(FRAME_BITS)
  let zAcc = 0
  for (let k = 0; k < FRAME_BITS; k++) {
    bits[k] = sum[k] > 0 ? 1 : 0
    zAcc += Math.abs(sum[k]) / Math.sqrt(energy[k] + 1e-9)
  }
  let disagree = 0
  for (let s = 0; s < L.slots; s++) if (soft[s] > 0 !== (bits[L.slotBit[s]] === 1)) disagree++
  return { bits, score: zAcc / FRAME_BITS, rawBitErrorRate: disagree / L.slots }
}

/** 截图常带纯色边框/状态栏：裁掉四周近似纯色的行列后再尝试 */
export function trimUniformBorders(img: RGBAImage, tolerance = 6): RGBAImage | null {
  const { width: W, height: H, data } = img
  const rowUniform = (y: number) => {
    const i0 = y * W * 4
    for (let x = 1; x < W; x++) {
      const i = i0 + x * 4
      if (Math.abs(data[i] - data[i0]) + Math.abs(data[i + 1] - data[i0 + 1]) + Math.abs(data[i + 2] - data[i0 + 2]) > tolerance)
        return false
    }
    return true
  }
  const colUniform = (x: number, y0: number, y1: number) => {
    const i0 = (y0 * W + x) * 4
    for (let y = y0 + 1; y < y1; y++) {
      const i = (y * W + x) * 4
      if (Math.abs(data[i] - data[i0]) + Math.abs(data[i + 1] - data[i0 + 1]) + Math.abs(data[i + 2] - data[i0 + 2]) > tolerance)
        return false
    }
    return true
  }
  let top = 0
  let bottom = H
  while (top < bottom - 1 && rowUniform(top)) top++
  while (bottom - 1 > top && rowUniform(bottom - 1)) bottom--
  let left = 0
  let right = W
  while (left < right - 1 && colUniform(left, top, bottom)) left++
  while (right - 1 > left && colUniform(right - 1, top, bottom)) right--
  if (top === 0 && left === 0 && bottom === H && right === W) return null
  const w = right - left
  const h = bottom - top
  if (w < 64 || h < 64) return null
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    out.set(data.subarray(((top + y) * W + left) * 4, ((top + y) * W + right) * 4), y * w * 4)
  return { width: w, height: h, data: out }
}

export function extractClassic(
  img: RGBAImage,
  opts: { key: string; canonical?: number; minScore?: number }
): ClassicExtractResult {
  const minScore = opts.minScore ?? 2.5
  const sizes = opts.canonical ? [opts.canonical] : CANONICAL_SIZES
  const candidates: Array<{ img: RGBAImage; trimmed: boolean }> = [{ img, trimmed: false }]
  const trimmed = trimUniformBorders(img)
  if (trimmed) candidates.push({ img: trimmed, trimmed: true })

  let best: ClassicExtractResult = {
    found: false,
    payload: null,
    score: 0,
    rawBitErrorRate: 0.5,
    canonical: sizes[0],
    trimmed: false,
  }
  for (const cand of candidates)
    for (const c of sizes) {
      const r = softDecode(cand.img, c, opts.key)
      if (!r) continue
      const { payload, crcOk } = unpackFrame(r.bits)
      const found = crcOk && r.score >= minScore
      if (found || r.score > best.score)
        best = {
          found,
          payload: found ? payload : null,
          score: r.score,
          rawBitErrorRate: r.rawBitErrorRate,
          canonical: c,
          trimmed: cand.trimmed,
        }
      if (found) return best
    }
  return best
}

export type { Plane }
