"use client"

import { Badge } from "@appica/ui-react/badge"
import { Button } from "@appica/ui-react/button"
import { Checkbox } from "@appica/ui-react/checkbox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog"
import { Input } from "@appica/ui-react/input"
import { KeyRound, Loader2 } from "lucide-react"
import { useId, useState } from "react"

import { Segmented } from "@/components/studio/controls"
import { useIdentity } from "@/lib/identity-store"
import { cn } from "@/lib/utils"
import { SIGNATURE_DISCLAIMER } from "@/lib/watermark/certificate"
import { formatKeyId, PBKDF2_ITERATIONS } from "@/lib/watermark/identity"

function saveText(text: string, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/** 身份摘要：名字、keyId、存储方式与备份状态 */
export function IdentitySummary({ className }: { className?: string }) {
  const identity = useIdentity((s) => s.identity)
  if (!identity) return null
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-lg bg-background-muted px-3 py-2.5", className)}>
      <p className="flex items-center gap-2 text-sm text-foreground-intense">
        <KeyRound className="size-3.5 text-foreground-muted" />
        <span className="truncate">{identity.name}</span>
      </p>
      <p className="font-mono text-xs text-foreground-strong">keyId {formatKeyId(identity.keyId)}</p>
      <div className="flex flex-wrap gap-1">
        <Badge size="xs" variant="soft">
          {identity.backend === "webcrypto" ? "WebCrypto · 私钥不可导出" : "noble 回退 · 私钥以字节保存"}
        </Badge>
        <Badge size="xs" variant={identity.backedUp ? "success" : "warning"}>
          {identity.backedUp ? "已加密备份" : "未备份"}
        </Badge>
      </div>
    </div>
  )
}

type Mode = "create" | "restore"

export function IdentityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-120">{open && <IdentityForm onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function IdentityForm({ onClose }: { onClose: () => void }) {
  const identity = useIdentity((s) => s.identity)
  const { create, restore, remove } = useIdentity.getState()
  const [mode, setMode] = useState<Mode>("create")
  const [name, setName] = useState(identity?.name ?? "")
  const [backup, setBackup] = useState(true)
  const [pass, setPass] = useState("")
  const [pass2, setPass2] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const formId = useId()

  const passOk = pass.length >= 8 && pass === pass2
  const canSubmit =
    mode === "create" ? name.trim().length > 0 && (!backup || passOk) : !!file && pass.length > 0

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (mode === "create") {
        const text = await create(name.trim(), backup ? pass : undefined)
        const id = useIdentity.getState().identity
        if (text && id) saveText(text, `veilmark-identity-${id.keyId}.json`)
      } else if (file) await restore(file, pass)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg">签名身份</DialogTitle>
        <DialogDescription>
          一把 Ed25519 密钥，用来给版权证书签名，任何人都能离线验签。{SIGNATURE_DISCLAIMER}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {identity && (
          <div className="flex flex-col gap-2">
            <IdentitySummary />
            {confirmRemove ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-error-subtle px-3 py-2 text-xs text-foreground-strong">
                <span>{identity.backedUp ? "移除后可用备份文件恢复。" : "此身份没有备份，移除后永久丢失，已签发的证书仍可验证但无法再用这把密钥签名。"}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    await remove()
                    setConfirmRemove(false)
                  }}
                >
                  确认移除
                </Button>
              </div>
            ) : (
              <button className="self-start text-xs text-foreground-muted hover:text-error-emphasis" onClick={() => setConfirmRemove(true)}>
                移除本机身份…
              </button>
            )}
            <p className="text-xs text-foreground-muted">在下方新建或恢复会替换当前身份（已签发的证书不受影响）。</p>
          </div>
        )}

        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m)
            setError(null)
          }}
          options={[
            { value: "create", label: "新建" },
            { value: "restore", label: "从备份恢复" },
          ]}
        />

        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit && !busy) submit()
          }}
        >
          {mode === "create" ? (
            <>
              <label className="flex flex-col gap-1.5 text-xs text-foreground-muted">
                署名（写入证书，公开可见）
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Marvin Studio" autoFocus />
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground-strong">
                <Checkbox checked={backup} onCheckedChange={(v) => setBackup(v === true)} className="mt-0.5" />
                <span>
                  创建时导出加密备份
                  <span className="block text-xs text-foreground-muted">
                    私钥用口令加密（PBKDF2-SHA256 {PBKDF2_ITERATIONS.toLocaleString()} 次 → AES-GCM）后下载。不备份则私钥永远无法导出，
                    清空浏览器数据即丢失。
                  </span>
                </span>
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-1.5 text-xs text-foreground-muted">
              备份文件
              <Input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          {(mode === "restore" || backup) && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="password" placeholder={mode === "create" ? "备份口令（至少 8 位）" : "备份口令"} value={pass} onChange={(e) => setPass(e.target.value)} />
              {mode === "create" && (
                <Input type="password" placeholder="再输入一次" value={pass2} onChange={(e) => setPass2(e.target.value)} />
              )}
            </div>
          )}
          {mode === "create" && backup && pass2.length > 0 && !passOk && (
            <p className="text-xs text-error-emphasis">{pass.length < 8 ? "口令至少 8 位" : "两次输入的口令不一致"}</p>
          )}
          {error && <p className="text-xs text-error-emphasis">{error}</p>}
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" form={formId} disabled={!canSubmit || busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {mode === "create" ? (backup ? "创建并下载备份" : "创建") : "恢复"}
        </Button>
      </DialogFooter>
    </>
  )
}
