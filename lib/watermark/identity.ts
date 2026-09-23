import * as ed from "@noble/ed25519"
import { createStore, del, entries, get, set } from "idb-keyval"

import { bufferOf, fromBase64Url, sha256, toBase64Url, toHex, utf8 } from "./core/bytes"

/**
 * 签名身份：一把 Ed25519 密钥。用它给版权证书签名，任何人都能离线验签。
 *
 * 签名只证明“这把密钥的持有者在 issuedAt 时自行声明了这些内容”，
 * 不是权威时间戳，也不是法律意义上的权属认定。
 *
 * 存储策略：
 * - 优先 WebCrypto Ed25519，私钥以“不可导出”的 CryptoKey 存进 IndexedDB——页面脚本也读不出私钥字节；
 * - 浏览器不支持时回退 @noble/ed25519，此时私钥只能以字节形式保存（在说明里提示）；
 * - 需要备份时，先生成可导出的密钥，把 32 字节种子用口令加密导出（PBKDF2-SHA256 60 万次 → AES-GCM），
 *   再以不可导出的方式导入保存。之后本机再也拿不到明文私钥，备份文件是唯一的迁移途径。
 */

export type SigningBackend = "webcrypto" | "noble"

export interface PublicIdentity {
  name: string
  /** base64url 编码的 32 字节原始公钥 */
  publicKey: string
  /** SHA-256(原始公钥) 前 16 位十六进制，用于线下比对 */
  keyId: string
  createdAt: string
  backend: SigningBackend
  /** 创建时是否导出过加密备份（不可导出的密钥事后无法再备份） */
  backedUp: boolean
}

export interface IdentityRecord extends PublicIdentity {
  privateKey: CryptoKey | Uint8Array
}

export const BACKUP_FORMAT = "veilmark.identity-backup/v1"
export const PBKDF2_ITERATIONS = 600_000

/** Ed25519 PKCS#8 = 固定 16 字节前缀 + 32 字节种子 */
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const seedToPkcs8 = (seed: Uint8Array) => {
  const out = new Uint8Array(48)
  out.set(PKCS8_PREFIX)
  out.set(seed, 16)
  return out
}

// ---------------------------------------------------------------------------
// 纯函数：指纹、创作者 ID、验签（Node 与浏览器通用）
// ---------------------------------------------------------------------------

export async function keyIdFromPublicKey(publicKey: Uint8Array): Promise<string> {
  return toHex(await sha256(publicKey)).slice(0, 16)
}

/** 把 keyId 排成 4 组，方便口头 / 线下逐段比对 */
export const formatKeyId = (keyId: string) => keyId.match(/.{1,4}/g)?.join("-") ?? keyId

/**
 * 可选：用签名身份派生创作者 ID（SHA-256(公钥) 的前 24 bit）。
 * 这样图里嵌入的指纹就与这把密钥绑定，别人拿自己的密钥签同一个指纹时，创作者 ID 对不上。
 */
export async function creatorIdFromPublicKey(publicKey: Uint8Array): Promise<number> {
  const d = await sha256(publicKey)
  return (d[0] << 16) | (d[1] << 8) | d[2]
}

let webCryptoEd25519: Promise<boolean> | null = null
/** 探测 WebCrypto 是否支持 Ed25519（Chrome 137+、Safari 17+、Firefox 129+、Node 20+） */
export function ed25519WebCryptoAvailable(): Promise<boolean> {
  webCryptoEd25519 ??= crypto.subtle
    .generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
    .then(() => true)
    .catch(() => false)
  return webCryptoEd25519
}

export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  if (await ed25519WebCryptoAvailable()) {
    try {
      const key = await crypto.subtle.importKey("raw", bufferOf(publicKey), { name: "Ed25519" }, false, ["verify"])
      return await crypto.subtle.verify({ name: "Ed25519" }, key, bufferOf(signature), bufferOf(message))
    } catch {
      // 个别实现拒绝导入非规范公钥，交给 noble 给出确定结论
    }
  }
  try {
    return await ed.verifyAsync(signature, message, publicKey)
  } catch {
    return false
  }
}

export async function signWithIdentity(id: Pick<IdentityRecord, "privateKey">, message: Uint8Array): Promise<Uint8Array> {
  if (id.privateKey instanceof Uint8Array) return ed.signAsync(message, id.privateKey)
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, id.privateKey, bufferOf(message)))
}

// ---------------------------------------------------------------------------
// 创建 / 备份 / 恢复
// ---------------------------------------------------------------------------

async function recordFromSeed(
  seed: Uint8Array,
  meta: { name: string; createdAt: string; backedUp: boolean }
): Promise<IdentityRecord> {
  const publicKey = await ed.getPublicKeyAsync(seed)
  const base = { ...meta, publicKey: toBase64Url(publicKey), keyId: await keyIdFromPublicKey(publicKey) }
  if (await ed25519WebCryptoAvailable()) {
    const privateKey = await crypto.subtle.importKey("pkcs8", bufferOf(seedToPkcs8(seed)), { name: "Ed25519" }, false, ["sign"])
    return { ...base, backend: "webcrypto", privateKey }
  }
  return { ...base, backend: "noble", privateKey: seed.slice() }
}

/**
 * 创建签名身份。
 * - 不备份：WebCrypto 直接生成不可导出的密钥，私钥字节从未出现在 JS 内存里；
 * - 备份：生成种子 → 加密导出备份 → 以不可导出方式导入。返回备份文件文本，由调用方让用户下载。
 */
export async function createIdentity(
  name: string,
  opts: { passphrase?: string; iterations?: number } = {}
): Promise<{ record: IdentityRecord; backup?: string }> {
  const createdAt = new Date().toISOString()
  if (!opts.passphrase) {
    if (await ed25519WebCryptoAvailable()) {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair
      const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
      return {
        record: {
          name,
          createdAt,
          backedUp: false,
          backend: "webcrypto",
          publicKey: toBase64Url(publicKey),
          keyId: await keyIdFromPublicKey(publicKey),
          privateKey: pair.privateKey,
        },
      }
    }
    return { record: await recordFromSeed(ed.utils.randomSecretKey(), { name, createdAt, backedUp: false }) }
  }
  const seed = crypto.getRandomValues(new Uint8Array(32))
  try {
    const record = await recordFromSeed(seed, { name, createdAt, backedUp: true })
    const backup = await encryptBackup(seed, record, opts.passphrase, opts.iterations)
    return { record, backup }
  } finally {
    seed.fill(0)
  }
}

export interface IdentityBackupFile {
  format: typeof BACKUP_FORMAT
  name: string
  publicKey: string
  keyId: string
  createdAt: string
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string }
  cipher: { name: "AES-GCM"; iv: string }
  ciphertext: string
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", bufferOf(utf8(passphrase.normalize("NFKC"))), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bufferOf(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/** 附加认证数据：把公钥等元信息绑进密文，换掉备份文件里的公钥/名字会解密失败 */
const backupAad = (b: Pick<IdentityBackupFile, "keyId" | "publicKey">) => utf8(`${BACKUP_FORMAT}|${b.keyId}|${b.publicKey}`)

export async function encryptBackup(
  seed: Uint8Array,
  id: Pick<PublicIdentity, "name" | "publicKey" | "keyId" | "createdAt">,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, iterations)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferOf(iv), additionalData: bufferOf(backupAad(id)) }, key, bufferOf(seed))
  )
  const file: IdentityBackupFile = {
    format: BACKUP_FORMAT,
    name: id.name,
    publicKey: id.publicKey,
    keyId: id.keyId,
    createdAt: id.createdAt,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64Url(salt) },
    cipher: { name: "AES-GCM", iv: toBase64Url(iv) },
    ciphertext: toBase64Url(ciphertext),
  }
  return JSON.stringify(file, null, 2) + "\n"
}

/** 用口令解密备份并恢复身份；口令错误或文件被改动都会抛错 */
export async function restoreIdentity(text: string, passphrase: string): Promise<IdentityRecord> {
  let file: IdentityBackupFile
  try {
    file = JSON.parse(text)
  } catch {
    throw new Error("备份文件不是合法的 JSON")
  }
  if (file?.format !== BACKUP_FORMAT) throw new Error("不是 Veilmark 签名身份备份文件")
  if (file.kdf?.name !== "PBKDF2" || file.cipher?.name !== "AES-GCM") throw new Error("不支持的加密参数")
  const key = await deriveKey(passphrase, fromBase64Url(file.kdf.salt), file.kdf.iterations)
  let seed: Uint8Array
  try {
    seed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bufferOf(fromBase64Url(file.cipher.iv)), additionalData: bufferOf(backupAad(file)) },
        key,
        bufferOf(fromBase64Url(file.ciphertext))
      )
    )
  } catch {
    throw new Error("口令错误，或备份文件已被改动")
  }
  try {
    const record = await recordFromSeed(seed, { name: file.name, createdAt: file.createdAt, backedUp: true })
    if (record.publicKey !== file.publicKey) throw new Error("备份内容与公钥不符")
    return record
  } finally {
    seed.fill(0)
  }
}

export const toPublic = ({ privateKey: _drop, ...pub }: IdentityRecord): PublicIdentity => {
  void _drop
  return pub
}

// ---------------------------------------------------------------------------
// IndexedDB：本机身份（只存一把当前身份）与“已信任的公钥”
// ---------------------------------------------------------------------------

const identityStore = () => createStore("veilmark-identity", "keys")
const trustStore = () => createStore("veilmark-trust", "keys")

export const identityDb = {
  get: () => get<IdentityRecord>("active", identityStore()),
  put: (r: IdentityRecord) => set("active", r, identityStore()),
  remove: () => del("active", identityStore()),
}

export interface TrustedKey {
  keyId: string
  publicKey: string
  label: string
  addedAt: string
}

export const trustDb = {
  async list(): Promise<TrustedKey[]> {
    const all = await entries<string, TrustedKey>(trustStore())
    return all.map(([, v]) => v).sort((a, b) => a.addedAt.localeCompare(b.addedAt))
  },
  get: (keyId: string) => get<TrustedKey>(keyId, trustStore()),
  /** 按 keyId 存，但比对时同时核对完整公钥，防止 64 bit 指纹碰撞 */
  put: (k: TrustedKey) => set(k.keyId, k, trustStore()),
  remove: (keyId: string) => del(keyId, trustStore()),
}
