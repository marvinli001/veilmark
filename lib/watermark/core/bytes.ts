/** 字节工具：base64url、十六进制、SHA-256。浏览器、Worker 与 Node（WebCrypto）通用 */

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("不是合法的 base64url 字符串")
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const utf8 = (s: string) => new TextEncoder().encode(s)

/** WebCrypto 的参数类型要求 ArrayBuffer 背书的视图；统一复制一份，避免 SharedArrayBuffer/子视图的类型与偏移问题 */
export function bufferOf(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.slice().buffer as ArrayBuffer
}

export async function sha256(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferOf(bytes)))
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  return toHex(await sha256(bytes))
}
