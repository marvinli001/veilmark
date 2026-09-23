/**
 * PNG 元数据：把版权证书写进 iTXt 块（关键字 veilmark:cert）。
 *
 * PNG = 8 字节签名 + 若干块；每块 = 长度(4, 大端) + 类型(4) + 数据 + CRC32(类型+数据)。
 * iTXt 数据 = 关键字 \0 压缩标志(1) 压缩方法(1) 语言标签 \0 翻译关键字 \0 UTF-8 文本。
 * 这是辅助块（首字母小写），解码器会忽略它，所以写入后像素与盲水印都不受影响。
 *
 * 为什么放在 IHDR 之后：元数据读取器通常只扫文件头部；放在 IDAT 之前能尽早读到。
 * WebP 的 XMP 写入在路线图里，本次不做。
 */

export const CERT_KEYWORD = "veilmark:cert"
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32（ISO-HDLC，PNG 规范附录的算法） */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function isPng(bytes: Uint8Array) {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b)
}

export interface PngChunk {
  type: string
  /** 整块（含长度、类型、CRC）在文件中的起止位置 */
  start: number
  end: number
  data: Uint8Array
  crcOk: boolean
}

export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error("不是 PNG 文件")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: PngChunk[] = []
  let o = 8
  while (o + 12 <= bytes.length) {
    const len = view.getUint32(o)
    const end = o + 12 + len
    if (end > bytes.length) break // 截断的文件：到此为止
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8))
    const crcOk = crc32(bytes, o + 4, o + 8 + len) === view.getUint32(o + 8 + len)
    out.push({ type, start: o, end, data: bytes.subarray(o + 8, o + 8 + len), crcOk })
    o = end
    if (type === "IEND") break
  }
  return out
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** 未压缩的 iTXt：关键字只允许 Latin-1 可打印字符（1–79 字节），文本为 UTF-8 */
export function makeITXt(keyword: string, text: string): Uint8Array {
  if (!/^[\x20-\x7e\xa1-\xff]{1,79}$/.test(keyword)) throw new Error("iTXt 关键字不合法")
  const kw = Uint8Array.from(keyword, (c) => c.charCodeAt(0))
  const body = new TextEncoder().encode(text)
  // 关键字 \0 | 压缩标志 0 | 压缩方法 0 | 语言标签 "" \0 | 翻译关键字 "" \0 | 文本
  const data = new Uint8Array(kw.length + 5 + body.length)
  data.set(kw, 0)
  data.set(body, kw.length + 5)
  return makeChunk("iTXt", data)
}

interface ITXt {
  keyword: string
  compressed: boolean
  text: Uint8Array
}

function parseITXt(data: Uint8Array): ITXt | null {
  const z1 = data.indexOf(0)
  if (z1 < 1 || z1 + 3 > data.length) return null
  const keyword = String.fromCharCode(...data.subarray(0, z1))
  const compressed = data[z1 + 1] === 1
  const z2 = data.indexOf(0, z1 + 3) // 语言标签结束
  if (z2 < 0) return null
  const z3 = data.indexOf(0, z2 + 1) // 翻译关键字结束
  if (z3 < 0) return null
  return { keyword, compressed, text: data.subarray(z3 + 1) }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 读取指定关键字的 iTXt 文本（支持 zlib 压缩的 iTXt；CRC 损坏的块跳过） */
export async function readITXt(bytes: Uint8Array, keyword = CERT_KEYWORD): Promise<string | null> {
  if (!isPng(bytes)) return null
  for (const c of readChunks(bytes)) {
    if (c.type !== "iTXt" || !c.crcOk) continue
    const t = parseITXt(c.data)
    if (!t || t.keyword !== keyword) continue
    const raw = t.compressed ? await inflate(t.text) : t.text
    return new TextDecoder().decode(raw)
  }
  return null
}

/** 去掉指定关键字的所有 iTXt 块（其余字节原样保留） */
export function removeITXt(bytes: Uint8Array, keyword = CERT_KEYWORD): Uint8Array {
  const drop = readChunks(bytes).filter((c) => c.type === "iTXt" && parseITXt(c.data)?.keyword === keyword)
  if (!drop.length) return bytes
  const parts: Uint8Array[] = []
  let o = 0
  for (const c of drop) {
    parts.push(bytes.subarray(o, c.start))
    o = c.end
  }
  parts.push(bytes.subarray(o))
  return concat(parts)
}

/** 写入（或替换）iTXt 块，放在 IHDR 之后 */
export function writeITXt(bytes: Uint8Array, text: string, keyword = CERT_KEYWORD): Uint8Array {
  const clean = removeITXt(bytes, keyword)
  const ihdr = readChunks(clean)[0]
  if (!ihdr || ihdr.type !== "IHDR") throw new Error("PNG 缺少 IHDR")
  return concat([clean.subarray(0, ihdr.end), makeITXt(keyword, text), clean.subarray(ihdr.end)])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * 证书里的 outputSha256 按“去掉 veilmark:cert 块后”的字节计算：
 * 证书写进文件后文件字节必然改变，不可能让证书包含自身所在文件的哈希。
 * 非 PNG 文件原样返回。
 */
export function canonicalFileBytes(bytes: Uint8Array): Uint8Array {
  return isPng(bytes) ? removeITXt(bytes, CERT_KEYWORD) : bytes
}
