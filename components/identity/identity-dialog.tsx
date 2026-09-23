"use client"

import { Badge } from "@appica/ui-react/badge"
import { Button } from "@appica/ui-react/button"
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
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { SIGNATURE_DISCLAIMER } from "@/lib/watermark/certificate"
import { certificateCreator, formatKeyId, PBKDF2_ITERATIONS } from "@/lib/watermark/identity"

function saveText(text: string, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/**
 * 身份摘要。默认是导出面板里的一行状态（署名取自“署名”字段）；detail 时再列出存储方式与备份状态。
 */
export function IdentitySummary({ detail, className }: { detail?: boolean; className?: string }) {
  const identity = useIdentity((s) => s.identity)
  const author = useStudio((s) => s.job.author)
  if (!identity) return null
  const { name } = certificateCreator(identity, author)
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg bg-background-muted px-3 py-2.5", className)}>
      <p className="flex items-center gap-2 text-sm text-foreground-intense">
        <KeyRound className="size-3.5 shrink-0 text-foreground-muted" />
        <span className="truncate">{name ? `署名「${name}」` : "未署名"}</span>
      </p>
      <p className="font-mono text-xs text-foreground-strong">keyId {formatKeyId(identity.keyId)}</p>
      {detail ? (
        <div className="mt-0.5 flex flex-wrap gap-1">
          <Badge size="xs" variant="soft">
            {identity.backend === "webcrypto" ? "WebCrypto · 私钥不可导出" : "noble 回退 · 私钥以字节保存"}
          </Badge>
          <Badge size="xs" variant={identity.backedUp ? "success" : "soft"}>
            {identity.backedUp ? "已加密备份" : "仅存本机"}
          </Badge>
        </div>
      ) : (
        !name && <p className="text-[11px] text-foreground-muted">填写顶部的“署名”后会一并写进证书</p>
      )}
    </div>
  )
}

type Mode = "create" | "restore"

/** 高级：备份 / 恢复 / 更换本机签名身份。平常导出不需要打开它 */
export function IdentityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-120">{open && <IdentityForm onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function IdentityForm({ onClose }: { onClose: () => void }) {
  const identity = useIdentity((s) => s.identity)
  const { create, restore, reset } = useIdentity.getState()
  const [mode, setMode] = useState<Mode>("create")
  const [pass, setPass] = useState("")
  const [pass2, setPass2] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const formId = useId()

  const passOk = pass.length >= 8 && pass === pass2
  const canSubmit = mode === "create" ? passOk : !!file && pass.length > 0

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (mode === "create") {
        // 身份自带的名字只用作备份文件与信任列表的标签；证书署名始终取“署名”字段
        const text = await create(useStudio.getState().job.author.trim(), pass)
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
          导出时会自动用这把本机密钥签发证书，平常不需要来这里。要在别的设备、或清空浏览器数据后继续用同一身份，就新建一把可备份的身份，或从备份恢复。
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {identity && (
          <div className="flex flex-col gap-2">
            <IdentitySummary detail />
            {confirmReset ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-error-subtle px-3 py-2 text-xs text-foreground-strong">
                <span>
                  {identity.backedUp ? "当前身份可用备份文件恢复。" : "当前密钥没有备份，换掉后无法再用它签名。"}已签发的证书仍可验证。
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    await reset()
                    setConfirmReset(false)
                  }}
                >
                  确认更换
                </Button>
              </div>
            ) : (
              <button className="self-start text-xs text-foreground-muted hover:text-error-emphasis" onClick={() => setConfirmReset(true)}>
                换一把新密钥…
              </button>
            )}
          </div>
        )}

        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m)
            setError(null)
          }}
          options={[
            { value: "create", label: "新建可备份身份" },
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
            <p className="text-xs leading-relaxed text-foreground-muted">
              私钥用口令加密（PBKDF2-SHA256 {PBKDF2_ITERATIONS.toLocaleString()} 次 → AES-GCM）后下载，这是把身份迁到其他设备的唯一途径。口令丢了无法找回。
            </p>
          ) : (
            <label className="flex flex-col gap-1.5 text-xs text-foreground-muted">
              备份文件
              <Input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              type="password"
              placeholder={mode === "create" ? "备份口令（至少 8 位）" : "备份口令"}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoFocus={mode === "create"}
            />
            {mode === "create" && <Input type="password" placeholder="再输入一次" value={pass2} onChange={(e) => setPass2(e.target.value)} />}
          </div>
          {mode === "create" && pass2.length > 0 && !passOk && (
            <p className="text-xs text-error-emphasis">{pass.length < 8 ? "口令至少 8 位" : "两次输入的口令不一致"}</p>
          )}
          {error && <p className="text-xs text-error-emphasis">{error}</p>}
          <p className="text-[11px] leading-relaxed text-foreground-subtle">
            新建或恢复会替换当前身份，已签发的证书不受影响。{SIGNATURE_DISCLAIMER}
          </p>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" form={formId} disabled={!canSubmit || busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {mode === "create" ? "创建并下载备份" : "恢复"}
        </Button>
      </DialogFooter>
    </>
  )
}
