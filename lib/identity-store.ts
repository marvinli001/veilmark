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
 */
interface IdentityState {
  loaded: boolean
  identity: PublicIdentity | null
  /** 由公钥派生的 24 bit 创作者 ID（开启“用签名身份派生创作者 ID”时写入指纹） */
  creatorId: number | null
  trusted: TrustedKey[]

  load(): Promise<void>
  create(name: string, passphrase?: string): Promise<string | undefined>
  restore(file: Blob, passphrase: string): Promise<void>
  remove(): Promise<void>
  trust(k: Omit<TrustedKey, "addedAt">): Promise<void>
  untrust(keyId: string): Promise<void>
  /** 取出带私钥的完整记录（签名时用） */
  signer(): Promise<IdentityRecord | null>
}

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

  async create(name, passphrase) {
    const { record, backup } = await createIdentity(name, { passphrase })
    await identityDb.put(record)
    // 自己的公钥默认信任：验证自己导出的图时“公钥已信任”一项直接通过
    await get().trust({ keyId: record.keyId, publicKey: record.publicKey, label: `${record.name}（本机身份）` })
    set(await adopt(record))
    return backup
  },

  async restore(file, passphrase) {
    const record = await restoreIdentity(await file.text(), passphrase)
    await identityDb.put(record)
    await get().trust({ keyId: record.keyId, publicKey: record.publicKey, label: `${record.name}（本机身份）` })
    set(await adopt(record))
  },

  async remove() {
    await identityDb.remove()
    set({ identity: null, creatorId: null })
  },

  async trust(k) {
    await trustDb.put({ ...k, addedAt: new Date().toISOString() })
    set({ trusted: await trustDb.list() })
  },

  async untrust(keyId) {
    await trustDb.remove(keyId)
    set({ trusted: await trustDb.list() })
  },

  signer: async () => (await identityDb.get()) ?? null,
}))
