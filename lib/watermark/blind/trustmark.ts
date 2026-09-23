import type { InferenceSession, Tensor } from "onnxruntime-web"

import { createPlane, resizePlane, type RGBAImage } from "../core/image"
import { FRAME_BITS, packFrame, unpackFrame, type BlindPayload } from "./payload"

/**
 * 深度学习盲水印引擎 · Adobe TrustMark（MIT，代码与权重均可商用）
 *
 * 与 TrustMark Python 实现一致的“任意分辨率”技巧：
 *   原图 → 双线性缩到 256² → 编码器输出含水印图 → 残差 = 输出 − 输入（去掉逐通道均值防偏色）
 *   → 残差双线性放大回原尺寸 → 叠加。检测端同样缩到 256² 后解码 100 bit。
 * 宽高比 > 2 时只处理中心正方形（与官方行为一致）。
 *
 * 模型：encoder_Q.onnx ≈ 17 MB、decoder_Q.onnx ≈ 47 MB（C 变体解码器 ≈ 22 MB）。
 * 建议自托管到 /public/models 或对象存储，首次使用时懒加载并写入 Cache Storage。
 *
 * 载荷映射：100 bit = 72 bit 帧（56 数据 + CRC16）+ 前 28 bit 的重复。
 * 解码时对重复位做软合并，再对最不可信的少数比特做 Chase 翻转 + CRC 校验。
 * （路线图：移植官方 BCH 数据层以与 Adobe/C2PA 生态互通。）
 */

export type OrtModule = {
  Tensor: typeof Tensor
  InferenceSession: typeof InferenceSession
}

export const TM_RES = 256
export const TM_BITS = 100
const REPEAT = TM_BITS - FRAME_BITS // 28

export interface TrustMarkSessions {
  encoder?: InferenceSession
  decoder: InferenceSession
}

export async function loadTrustMark(
  ort: OrtModule,
  baseUrl: string,
  opts: { variant?: "Q" | "C" | "B" | "P"; withEncoder?: boolean; providers?: string[] } = {}
): Promise<TrustMarkSessions> {
  const v = opts.variant ?? "Q"
  const executionProviders = opts.providers ?? ["webgpu", "wasm"]
  const [decoder, encoder] = await Promise.all([
    ort.InferenceSession.create(`${baseUrl}/decoder_${v}.onnx`, { executionProviders }),
    opts.withEncoder === false
      ? Promise.resolve(undefined)
      : ort.InferenceSession.create(`${baseUrl}/encoder_${v}.onnx`, { executionProviders }),
  ])
  return { encoder, decoder }
}

/** 中心正方形区域（宽高比 > 2 时），否则整图 */
function workRegion(W: number, H: number) {
  const ar = Math.max(W, H) / Math.min(W, H)
  if (ar <= 2) return { x: 0, y: 0, w: W, h: H }
  const s = Math.min(W, H)
  return { x: Math.floor((W - s) / 2), y: Math.floor((H - s) / 2), w: s, h: s }
}

function channelPlane(img: RGBAImage, c: number, r: { x: number; y: number; w: number; h: number }) {
  const p = createPlane(r.w, r.h)
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) p.data[y * r.w + x] = img.data[((r.y + y) * img.width + r.x + x) * 4 + c]
  return p
}

/** RGBA → [1,3,256,256]，值域 [−1,1]（与 torchvision ToTensor()*2−1 一致） */
function toModelInput(ort: OrtModule, img: RGBAImage) {
  const r = workRegion(img.width, img.height)
  const data = new Float32Array(3 * TM_RES * TM_RES)
  for (let c = 0; c < 3; c++) {
    const small = resizePlane(channelPlane(img, c, r), TM_RES, TM_RES)
    for (let i = 0; i < small.data.length; i++) data[c * TM_RES * TM_RES + i] = small.data[i] / 127.5 - 1
  }
  return { tensor: new ort.Tensor("float32", data, [1, 3, TM_RES, TM_RES]), region: r }
}

export function frameTo100(payload: BlindPayload): Float32Array {
  const frame = packFrame(payload)
  const bits = new Float32Array(TM_BITS)
  for (let i = 0; i < FRAME_BITS; i++) bits[i] = frame[i]
  for (let i = 0; i < REPEAT; i++) bits[FRAME_BITS + i] = frame[i]
  return bits
}

export async function embedTrustMark(
  ort: OrtModule,
  sessions: TrustMarkSessions,
  img: RGBAImage,
  payload: BlindPayload,
  strength = 1
): Promise<RGBAImage> {
  if (!sessions.encoder) throw new Error("未加载 TrustMark 编码器")
  const { tensor, region } = toModelInput(ort, img)
  const secret = new ort.Tensor("float32", frameTo100(payload), [1, TM_BITS])
  const [inImage, inSecret] = sessions.encoder.inputNames
  const result = await sessions.encoder.run({ [inImage]: tensor, [inSecret]: secret })
  const stego = result[sessions.encoder.outputNames[0]].data as Float32Array
  const cover = tensor.data as Float32Array

  const out: RGBAImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  const N = TM_RES * TM_RES
  for (let c = 0; c < 3; c++) {
    const res = createPlane(TM_RES, TM_RES)
    let mean = 0
    for (let i = 0; i < N; i++) {
      const s = Math.max(-1, Math.min(1, stego[c * N + i]))
      res.data[i] = s - cover[c * N + i]
      mean += res.data[i]
    }
    mean /= N
    for (let i = 0; i < N; i++) res.data[i] = (res.data[i] - mean) * 127.5 * strength
    const up = resizePlane(res, region.w, region.h)
    for (let y = 0; y < region.h; y++)
      for (let x = 0; x < region.w; x++) {
        const o = ((region.y + y) * img.width + region.x + x) * 4 + c
        out.data[o] = img.data[o] + up.data[y * region.w + x]
      }
  }
  return out
}

export interface TrustMarkResult {
  found: boolean
  payload: BlindPayload | null
  /** 平均 |logit|，越大越可信 */
  confidence: number
  flippedBits: number
}

export async function decodeTrustMark(
  ort: OrtModule,
  sessions: TrustMarkSessions,
  img: RGBAImage,
  opts: { minConfidence?: number; chaseBits?: number } = {}
): Promise<TrustMarkResult> {
  const { tensor } = toModelInput(ort, img)
  const d = sessions.decoder
  const result = await d.run({ [d.inputNames[0]]: tensor })
  const logits = result[d.outputNames[0]].data as Float32Array

  // 软合并重复位
  const soft = new Float32Array(FRAME_BITS)
  for (let i = 0; i < FRAME_BITS; i++) soft[i] = logits[i] + (i < REPEAT ? logits[FRAME_BITS + i] : 0)
  const confidence = logits.reduce((a, v) => a + Math.abs(v), 0) / TM_BITS
  const hard = Array.from(soft, (v) => (v > 0 ? 1 : 0))

  // Chase：只翻转最不可信的 k 位，k 很小以控制 CRC 误接受概率
  const k = opts.chaseBits ?? 3
  const weakest = Array.from(soft.keys())
    .sort((a, b) => Math.abs(soft[a]) - Math.abs(soft[b]))
    .slice(0, k)
  for (let mask = 0; mask < 1 << k; mask++) {
    const bits = hard.slice()
    let flips = 0
    for (let j = 0; j < k; j++)
      if (mask & (1 << j)) {
        bits[weakest[j]] ^= 1
        flips++
      }
    const { payload, crcOk } = unpackFrame(bits)
    if (crcOk && confidence >= (opts.minConfidence ?? 3)) return { found: true, payload, confidence, flippedBits: flips }
  }
  return { found: false, payload: null, confidence, flippedBits: 0 }
}
