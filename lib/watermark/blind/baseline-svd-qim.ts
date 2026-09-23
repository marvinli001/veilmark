import {
  addLumaResidual,
  canonicalDims,
  createPlane,
  lumaPlane,
  resizePlane,
  type RGBAImage,
} from "../core/image"
import { deriveSeed, keyedBits, keyedPermutation } from "../core/prng"
import { FRAME_BITS, packFrame, unpackFrame, type BlindPayload } from "./payload"
import { haarLL, haarLLInverseDelta } from "./transforms"

/**
 * 对照基线：blind_watermark（guofei9987）式 DWT-DCT-SVD + QIM。
 * LL 子带 4×4 分块 → DCT → 最大奇异值 s0 按步长 d 量化。
 * 为了只比较“调制方式”，这里同样套用了规范化尺度，因此对缩放同样鲁棒；
 * 它输给 CDP 的地方在亮度/对比度/Gamma（见 scripts/bench-blind.ts 的对照表）。
 * 生产代码不使用本模块。
 */

const B = 4
const M4 = (() => {
  const m = new Float64Array(16)
  for (let u = 0; u < B; u++) {
    const a = u === 0 ? Math.sqrt(1 / B) : Math.sqrt(2 / B)
    for (let x = 0; x < B; x++) m[u * B + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * B))
  }
  return m
})()

function mul(a: Float64Array, b: Float64Array, ta: boolean, tb: boolean, out: Float64Array) {
  for (let i = 0; i < B; i++)
    for (let j = 0; j < B; j++) {
      let acc = 0
      for (let k = 0; k < B; k++)
        acc += (ta ? a[k * B + i] : a[i * B + k]) * (tb ? b[j * B + k] : b[k * B + j])
      out[i * B + j] = acc
    }
}

/** 幂迭代求最大奇异三元组 (s0, u, v) */
function topSingular(A: Float64Array) {
  const AtA = new Float64Array(16)
  mul(A, A, true, false, AtA)
  let v = [0.5, 0.5, 0.5, 0.5]
  for (let it = 0; it < 40; it++) {
    const nv = [0, 0, 0, 0]
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) nv[i] += AtA[i * 4 + k] * v[k]
    const n = Math.hypot(...nv) || 1
    v = nv.map((x) => x / n)
  }
  const Av = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) Av[i] += A[i * 4 + k] * v[k]
  const s0 = Math.hypot(...Av)
  const u = Av.map((x) => x / (s0 || 1))
  return { s0, u, v }
}

function layout(w: number, h: number, canonical: number, key: string) {
  const { width: cw, height: ch } = canonicalDims(w, h, canonical)
  const bx = Math.floor(cw / 2 / B)
  const by = Math.floor(ch / 2 / B)
  const n = bx * by
  const perm = keyedPermutation(n, deriveSeed(key, "svd-perm"))
  const whiten = keyedBits(n, deriveSeed(key, "svd-whiten"))
  return { cw, ch, bx, by, n, perm, whiten }
}

export function embedSvdQim(
  img: RGBAImage,
  payload: BlindPayload,
  opts: { key: string; step?: number; canonical?: number }
): RGBAImage {
  const d = opts.step ?? 36
  const L = layout(img.width, img.height, opts.canonical ?? 1024, opts.key)
  const frame = packFrame(payload)
  const out: RGBAImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  const ll = haarLL(resizePlane(lumaPlane(out), L.cw, L.ch))
  const dLL = createPlane(ll.width, ll.height)
  const X = new Float64Array(16)
  const C = new Float64Array(16)
  const T = new Float64Array(16)
  for (let b = 0; b < L.n; b++) {
    const bx = b % L.bx
    const by = Math.floor(b / L.bx)
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) X[y * B + x] = ll.data[(by * B + y) * ll.width + bx * B + x]
    mul(M4, X, false, false, T)
    mul(T, M4, false, true, C)
    const { s0, u, v } = topSingular(C)
    const bit = frame[L.perm[b] % FRAME_BITS] ^ L.whiten[b]
    const target = (Math.floor(s0 / d) + 0.25 + 0.5 * bit) * d
    const ds = target - s0
    // ΔC = ds·u·vᵀ，逆 DCT 得 ΔX
    for (let i = 0; i < B; i++) for (let j = 0; j < B; j++) C[i * B + j] = ds * u[i] * v[j]
    mul(M4, C, true, false, T)
    mul(T, M4, false, false, X)
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) dLL.data[(by * B + y) * ll.width + bx * B + x] = X[y * B + x]
  }
  addLumaResidual(out, resizePlane(haarLLInverseDelta(dLL, L.cw, L.ch), img.width, img.height))
  return out
}

export function extractSvdQim(img: RGBAImage, opts: { key: string; step?: number; canonical?: number }) {
  const d = opts.step ?? 36
  const L = layout(img.width, img.height, opts.canonical ?? 1024, opts.key)
  const ll = haarLL(resizePlane(lumaPlane(img), L.cw, L.ch))
  const sum = new Float64Array(FRAME_BITS)
  const X = new Float64Array(16)
  const C = new Float64Array(16)
  const T = new Float64Array(16)
  for (let b = 0; b < L.n; b++) {
    const bx = b % L.bx
    const by = Math.floor(b / L.bx)
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) X[y * B + x] = ll.data[(by * B + y) * ll.width + bx * B + x]
    mul(M4, X, false, false, T)
    mul(T, M4, false, true, C)
    const { s0 } = topSingular(C)
    const frac = s0 / d - Math.floor(s0 / d)
    let soft = -Math.sin(2 * Math.PI * frac) // +1 在 0.75（比特 1），−1 在 0.25（比特 0）
    if (L.whiten[b]) soft = -soft
    sum[L.perm[b] % FRAME_BITS] += soft
  }
  const bits = Array.from(sum, (s) => (s > 0 ? 1 : 0))
  return { bits, ...unpackFrame(bits) }
}
