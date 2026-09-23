import { createPlane, type Plane } from "../core/image"

/* ------------------------------ Haar DWT ------------------------------ */

/**
 * 一级正交 Haar 小波的 LL 子带：LL = (a+b+c+d)/2。
 * 盲水印只改 LL，所以不需要保存 LH/HL/HH——逆变换时细节带视为零增量。
 */
export function haarLL(src: Plane): Plane {
  const w = src.width >> 1
  const h = src.height >> 1
  const out = createPlane(w, h)
  const s = src.data
  const W = src.width
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W
    const r1 = r0 + W
    for (let x = 0; x < w; x++) {
      const c = 2 * x
      out.data[y * w + x] = (s[r0 + c] + s[r0 + c + 1] + s[r1 + c] + s[r1 + c + 1]) * 0.5
    }
  }
  return out
}

/** LL 增量的逆 Haar：每个 LL 增量 δ 均匀落到 2×2 像素上，各 δ/2 */
export function haarLLInverseDelta(deltaLL: Plane, width: number, height: number): Plane {
  const out = createPlane(width, height)
  const w = deltaLL.width
  for (let y = 0; y < deltaLL.height; y++) {
    const r0 = 2 * y * width
    const r1 = r0 + width
    for (let x = 0; x < w; x++) {
      const d = deltaLL.data[y * w + x] * 0.5
      if (d === 0) continue
      const c = 2 * x
      out.data[r0 + c] = d
      out.data[r0 + c + 1] = d
      out.data[r1 + c] = d
      out.data[r1 + c + 1] = d
    }
  }
  return out
}

/* ------------------------------ 8×8 DCT ------------------------------- */

export const N = 8

/** 正交 DCT-II 矩阵 M，满足 C = M·X·Mᵀ，X = Mᵀ·C·M */
const M = (() => {
  const m = new Float64Array(N * N)
  for (let u = 0; u < N; u++) {
    const a = u === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N)
    for (let x = 0; x < N; x++) m[u * N + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))
  }
  return m
})()

const tmp = new Float64Array(N * N)

/** block: 64 长度，行优先；原地变换 */
export function dct8(block: Float64Array): void {
  // tmp = M·X
  for (let u = 0; u < N; u++)
    for (let x = 0; x < N; x++) {
      let acc = 0
      for (let k = 0; k < N; k++) acc += M[u * N + k] * block[k * N + x]
      tmp[u * N + x] = acc
    }
  // C = tmp·Mᵀ
  for (let u = 0; u < N; u++)
    for (let v = 0; v < N; v++) {
      let acc = 0
      for (let k = 0; k < N; k++) acc += tmp[u * N + k] * M[v * N + k]
      block[u * N + v] = acc
    }
}

export function idct8(block: Float64Array): void {
  // tmp = Mᵀ·C
  for (let x = 0; x < N; x++)
    for (let v = 0; v < N; v++) {
      let acc = 0
      for (let k = 0; k < N; k++) acc += M[k * N + x] * block[k * N + v]
      tmp[x * N + v] = acc
    }
  // X = tmp·M
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++) {
      let acc = 0
      for (let k = 0; k < N; k++) acc += tmp[x * N + k] * M[k * N + y]
      block[x * N + y] = acc
    }
}

export function readBlock(p: Plane, bx: number, by: number, out: Float64Array): void {
  const W = p.width
  for (let y = 0; y < N; y++) {
    const row = (by * N + y) * W + bx * N
    for (let x = 0; x < N; x++) out[y * N + x] = p.data[row + x]
  }
}

export function writeBlock(p: Plane, bx: number, by: number, src: Float64Array): void {
  const W = p.width
  for (let y = 0; y < N; y++) {
    const row = (by * N + y) * W + bx * N
    for (let x = 0; x < N; x++) p.data[row + x] = src[y * N + x]
  }
}
