import { beforeEach, describe, expect, it, vi } from "vitest"

// Node 没有 IndexedDB：idb-keyval 换成内存 Map，每个 store 一张表
const dbs = new Map<string, Map<string, unknown>>()
vi.mock("idb-keyval", () => {
  const table = (s: string) => dbs.get(s) ?? dbs.set(s, new Map()).get(s)!
  return {
    createStore: (db: string, store: string) => `${db}/${store}`,
    get: async (k: string, s: string) => table(s).get(k),
    set: async (k: string, v: unknown, s: string) => void table(s).set(k, v),
    del: async (k: string, s: string) => void table(s).delete(k),
    entries: async (s: string) => [...table(s).entries()],
  }
})
vi.stubGlobal("indexedDB", {})

const { useIdentity } = await import("../lib/identity-store")
const { certificateCreator, signWithIdentity, verifyEd25519 } = await import("../lib/watermark/identity")
const { fromBase64Url, utf8 } = await import("../lib/watermark/core/bytes")

describe("静默生成的本机签名身份", () => {
  beforeEach(() => {
    dbs.clear()
    useIdentity.setState({ loaded: false, identity: null, creatorId: null, trusted: [] })
  })

  it("首次 ensure 静默生成一把不可导出的密钥，并默认信任自己的公钥", async () => {
    const record = await useIdentity.getState().ensure()
    expect(record).not.toBeNull()
    const { identity, creatorId, trusted } = useIdentity.getState()
    expect(identity?.keyId).toBe(record!.keyId)
    expect(identity?.backedUp).toBe(false)
    expect(creatorId).not.toBeNull()
    expect(trusted).toEqual([expect.objectContaining({ keyId: record!.keyId, label: "本机身份" })])
    if (record!.backend === "webcrypto") expect((record!.privateKey as CryptoKey).extractable).toBe(false)

    const msg = utf8("hello")
    expect(await verifyEd25519(fromBase64Url(record!.publicKey), await signWithIdentity(record!, msg), msg)).toBe(true)
  })

  it("并发调用只生成一把，之后复用已有身份", async () => {
    const [a, b, c] = await Promise.all([useIdentity.getState().ensure(), useIdentity.getState().ensure(), useIdentity.getState().signer()])
    expect(new Set([a!.keyId, b!.keyId, c!.keyId]).size).toBe(1)
    expect(useIdentity.getState().trusted).toHaveLength(1)
    expect((await useIdentity.getState().ensure())!.keyId).toBe(a!.keyId)
  })

  it("换一把新密钥：旧公钥仍在信任列表里", async () => {
    const old = await useIdentity.getState().ensure()
    await useIdentity.getState().reset()
    const now = useIdentity.getState().identity
    expect(now?.keyId).not.toBe(old!.keyId)
    expect(useIdentity.getState().trusted.map((k) => k.keyId).sort()).toEqual([old!.keyId, now!.keyId].sort())
  })

  it("证书署名取“署名”字段，没填时退回身份自带的名字", () => {
    const id = { name: "", publicKey: "pk", keyId: "kid" }
    expect(certificateCreator(id, "  Marvin Studio ")).toEqual({ name: "Marvin Studio", publicKey: "pk", keyId: "kid" })
    expect(certificateCreator(id, "").name).toBe("")
    expect(certificateCreator({ ...id, name: "旧备份里的名字" }, "").name).toBe("旧备份里的名字")
  })
})
