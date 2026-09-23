import { createStore, del, entries, get, set, setMany } from "idb-keyval"

import type { BlindPayload } from "./blind/payload"
import { validateCertificate, type Certificate } from "./certificate"

/**
 * 本地版权注册表：盲水印只携带 56 bit 指纹，完整信息存在这里（IndexedDB）。
 * 有签名身份时每条记录保存签名后的版权证书；验证页核验证书时也拿它当“参考副本”，
 * 被改动的证书能据此点名具体字段。
 * 可导出/导入 JSON 在设备间迁移；后续可替换为服务端（Vercel KV / Postgres）实现多人共享。
 */
export interface RegistryRecord {
  payloadHex: string
  payload: BlindPayload
  creatorName: string
  fileName: string
  /** 原图 SHA-256，用于日后举证“我有原图” */
  sourceSha256: string
  createdAt: string
  engines: string
  keyHint: string
  note?: string
  /** 签名后的版权证书（没有签名身份时导出的旧记录没有这一项） */
  certificate?: Certificate
}

const store = () => createStore("veilmark", "registry")

export { sha256Hex } from "./core/bytes"

export const registry = {
  put: (r: RegistryRecord) => set(r.payloadHex, r, store()),
  get: (hex: string) => get<RegistryRecord>(hex, store()),
  remove: (hex: string) => del(hex, store()),
  async list(): Promise<RegistryRecord[]> {
    const all = await entries<string, RegistryRecord>(store())
    return all.map(([, v]) => v).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },
  async exportJSON(): Promise<Blob> {
    return new Blob([JSON.stringify({ version: 1, records: await this.list() }, null, 2)], {
      type: "application/json",
    })
  },
  async importJSON(file: Blob): Promise<number> {
    const parsed = JSON.parse(await file.text()) as { records?: RegistryRecord[] }
    const records = (parsed.records ?? [])
      .filter((r) => /^[0-9a-f]{14}$/.test(r.payloadHex))
      // 结构不合法的证书丢掉，记录本身保留（证书的真伪在验证页逐项核验）
      .map((r) => (r.certificate && validateCertificate(r.certificate).length ? { ...r, certificate: undefined } : r))
    await setMany(records.map((r) => [r.payloadHex, r]), store())
    return records.length
  },
}
