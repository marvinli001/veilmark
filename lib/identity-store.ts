"use client"

import { create } from "zustand"

import { fromBase64Url } from "./watermark/core/bytes"
import {
  createIdentity,
  creatorIdFromPublicKey,
  identityDb,
  restoreIdentity,
  toPublic,
  trustDb,
  type IdentityRecord,
  type PublicIdentity,
  type TrustedKey,
} from "./watermark/identity"

/**
 * 签名身份与“已信任的公钥”。私钥只在签名那一刻从 IndexedDB 取出（CryptoKey 不可导出），
 * 这里只放公开信息，供工作台与验证页展示。
 *
 * 工作台打开时 ensure() 静默生成本机身份，用户不需要做任何配置；验证页只 load()，不会凭空生成密钥。
 */
interface IdentityState {
  loaded: boolean
  identity: PublicIdentity | null
  /** 由公钥派生的 24 bit 创作者 ID（开启“用签名身份派生创作者 ID”时写入指纹） */
  creatorId: number | null
  trusted: TrustedKey[]

  load(): Promise<void>
  /** 取本机身份，没有就静默生成一把（不可导出、不备份）；环境不支持 IndexedDB 时为 null */
  ensure(): Promise<IdentityRecord | null>
  create(name: string, passphrase?: string): Promise<string | undefined>
  restore(file: Blob, passphrase: string): Promise<void>
  /** 换一把新的本机密钥（旧公钥留在信任列表里，已签发的证书照常通过） */
  reset(): Promise<void>
  trust(k: Omit<TrustedKey, "addedAt">): Promise<void>
  untrust(keyId: string): Promise<void>
  /** 取出带私钥的完整记录（签名时用） */
  signer(): Promise<IdentityRecord | null>
}

/** 自己的公钥默认信任：验证自己导出的图时“公钥已信任”一项直接通过 */
const selfTrust = (r: IdentityRecord) => ({
  keyId: r.keyId,
  publicKey: r.publicKey,
  label: r.name ? `${r.name}（本机身份）` : "本机身份",
})

/** 同一时刻只生成一把（开发模式下 effect 会跑两次，导出也可能与首次打开同时触发） */
let ensuring: Promise<IdentityRecord> | null = null

async function adopt(record: IdentityRecord | undefined) {
  if (!record) return { identity: null, creatorId: null }
  return { identity: toPublic(record), creatorId: await creatorIdFromPublicKey(fromBase64Url(record.publicKey)) }
}

export const useIdentity = create<IdentityState>()((set, get) => ({
  loaded: false,
  identity: null,
  creatorId: null,
  trusted: [],

  async load() {
    if (typeof indexedDB === "undefined") return
    const [record, trusted] = await Promise.all([identityDb.get(), trustDb.list()])
    set({ ...(await adopt(record)), trusted, loaded: true })
  },

  async ensure() {
    if (typeof indexedDB === "undefined") return null
    ensuring ??= (async () => {
      const existing = await identityDb.get()
      if (existing) return existing
      const { record } = await createIdentity("")
      await identityDb.put(record)
      await get().trust(selfTrust(record))
      return record
    })().finally(() => (ensuring = null))
    const record = await ensuring
    if (get().identity?.keyId !== record.keyId) set(await adopt(record))
    return record
  },

  async create(name, passphrase) {
    const { record, backup } = await createIdentity(name, { passphrase })
    await identityDb.put(record)
    await get().trust(selfTrust(record))
    set(await adopt(record))
    return backup
  },

  async restore(file, passphrase) {
    const record = await restoreIdentity(await file.text(), passphrase)
    await identityDb.put(record)
    await get().trust(selfTrust(record))
    set(await adopt(record))
  },

  async reset() {
    await identityDb.remove()
    set({ identity: null, creatorId: null })
    await get().ensure()
  },

  async trust(k) {
    await trustDb.put({ ...k, addedAt: new Date().toISOString() })
    set({ trusted: await trustDb.list() })
  },

  async untrust(keyId) {
    await trustDb.remove(keyId)
    set({ trusted: await trustDb.list() })
  },

  signer: () => get().ensure(),
}))
