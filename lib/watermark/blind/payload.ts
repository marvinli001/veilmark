import { crc16Bits, fnv1a32 } from "../core/prng"

/**
 * 盲水印载荷：56 bit 数据 + 16 bit CRC = 72 bit 帧。
 *
 * 盲水印的物理容量很小（经典频域 ~100 bit、TrustMark 100 bit），不可能直接塞进
 * 任意长度的创作者名或完整哈希。因此载荷只放“紧凑指纹”，完整信息写进本地注册表
 * （IndexedDB，可导出 JSON），验证时用指纹反查。
 *
 * | 字段     | 位宽 | 说明                                        |
 * | -------- | ---- | ------------------------------------------- |
 * | version  | 3    | 载荷版式版本                                |
 * | creator  | 24   | 创作者 ID：数字直写，或文本经 FNV 折叠为 24 bit |
 * | day      | 15   | 自 2024-01-01 起的天数（覆盖约 89 年）       |
 * | serial   | 14   | 作品序号 / 原图 SHA-256 截断 / 随机数        |
 */
export interface BlindPayload {
  version: number
  creator: number
  day: number
  serial: number
}

export const PAYLOAD_BITS = 56
export const CRC_BITS = 16
export const FRAME_BITS = PAYLOAD_BITS + CRC_BITS

const FIELDS: Array<[keyof BlindPayload, number]> = [
  ["version", 3],
  ["creator", 24],
  ["day", 15],
  ["serial", 14],
]

const EPOCH = Date.UTC(2024, 0, 1)

export function dayFromDate(date: Date): number {
  return Math.max(0, Math.floor((date.getTime() - EPOCH) / 86_400_000)) & 0x7fff
}

export function dateFromDay(day: number): Date {
  return new Date(EPOCH + day * 86_400_000)
}

/** 文本创作者名 → 24 bit。纯数字字符串按数值直写，便于团队分配工号式 ID */
export function creatorIdFromText(text: string): number {
  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed) && Number(trimmed) < 1 << 24) return Number(trimmed)
  const h = fnv1a32(trimmed.normalize("NFKC"))
  return ((h >>> 24) ^ (h & 0xffffff)) & 0xffffff
}

/** 原图字节 → 14 bit 序号（SHA-256 截断），让同一作者同一天的不同作品可区分 */
export async function serialFromBytes(bytes: ArrayBuffer): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return ((digest[0] << 6) | (digest[1] >> 2)) & 0x3fff
}

export function packFrame(p: BlindPayload): Uint8Array {
  const bits = new Uint8Array(FRAME_BITS)
  let o = 0
  for (const [name, width] of FIELDS) {
    const v = p[name] >>> 0
    if (v >= 2 ** width) throw new RangeError(`${name} 超出 ${width} bit`)
    for (let b = width - 1; b >= 0; b--) bits[o++] = (v >>> b) & 1
  }
  const crc = crc16Bits(bits.subarray(0, PAYLOAD_BITS))
  for (let b = CRC_BITS - 1; b >= 0; b--) bits[o++] = (crc >>> b) & 1
  return bits
}

export function unpackFrame(bits: ArrayLike<number>): { payload: BlindPayload; crcOk: boolean } {
  let o = 0
  const payload = { version: 0, creator: 0, day: 0, serial: 0 } as BlindPayload
  for (const [name, width] of FIELDS) {
    let v = 0
    for (let b = 0; b < width; b++) v = v * 2 + (bits[o++] & 1)
    payload[name] = v
  }
  let crc = 0
  for (let b = 0; b < CRC_BITS; b++) crc = (crc << 1) | (bits[o++] & 1)
  const crcOk = crc16Bits(Array.prototype.slice.call(bits, 0, PAYLOAD_BITS)) === crc
  return { payload, crcOk }
}

/** 14 位十六进制指纹，作为注册表主键 */
export function payloadToHex(p: BlindPayload): string {
  const bits = packFrame(p).subarray(0, PAYLOAD_BITS)
  let hex = ""
  for (let i = 0; i < PAYLOAD_BITS; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16)
  }
  return hex
}
