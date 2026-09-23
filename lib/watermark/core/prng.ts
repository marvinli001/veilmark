/** 确定性伪随机工具：同一密钥在嵌入端和检测端必须产生完全相同的序列 */

/** FNV-1a 32 位字符串哈希（UTF-8） */
export function fnv1a32(input: string, seed = 0x811c9dc5): number {
  const bytes = new TextEncoder().encode(input)
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32：足够快、足够均匀，适合打乱与扩频，不用于密码学目的 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由密钥派生出互不相关的子种子（打乱表、白化序列各用一个） */
export function deriveSeed(key: string, purpose: string): number {
  return fnv1a32(`${purpose}\u0000${key}`)
}

/** Fisher–Yates 置换 */
export function keyedPermutation(n: number, seed: number): Uint32Array {
  const perm = new Uint32Array(n)
  for (let i = 0; i < n; i++) perm[i] = i
  const rnd = mulberry32(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = perm[i]
    perm[i] = perm[j]
    perm[j] = t
  }
  return perm
}

/** 0/1 白化序列：让全零载荷也不会产生规则纹理，且无密钥者无法判定比特 */
export function keyedBits(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  const rnd = mulberry32(seed)
  for (let i = 0; i < n; i++) out[i] = rnd() < 0.5 ? 0 : 1
  return out
}

/** CRC-16/CCITT-FALSE，按比特处理 */
export function crc16Bits(bits: ArrayLike<number>): number {
  let crc = 0xffff
  for (let i = 0; i < bits.length; i++) {
    const top = (crc >> 15) & 1
    crc = (crc << 1) & 0xffff
    if ((top ^ (bits[i] & 1)) === 1) crc ^= 0x1021
  }
  return crc
}
