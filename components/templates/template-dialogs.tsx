"use client"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@appica/ui-react/alert-dialog"
import { Button } from "@appica/ui-react/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@appica/ui-react/dialog"
import { Input } from "@appica/ui-react/input"
import { Textarea } from "@appica/ui-react/textarea"
import { useId, useState } from "react"

/** 保存为 / 新建 / 重命名共用的名称表单 */
export function NameDialog({
  open,
  title,
  confirmLabel,
  initialName = "",
  initialDescription = "",
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  confirmLabel: string
  initialName?: string
  initialDescription?: string
  onClose: () => void
  onSubmit: (name: string, description: string) => void | Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-110">
        {/* key 让每次打开都用最新的初始值重建表单，而不是在 effect 里同步 state */}
        {open && (
          <NameForm
            key={initialName}
            title={title}
            confirmLabel={confirmLabel}
            initialName={initialName}
            initialDescription={initialDescription}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function NameForm({
  title,
  confirmLabel,
  initialName,
  initialDescription,
  onClose,
  onSubmit,
}: {
  title: string
  confirmLabel: string
  initialName: string
  initialDescription: string
  onClose: () => void
  onSubmit: (name: string, description: string) => void | Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [busy, setBusy] = useState(false)
  const formId = useId()
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await onSubmit(name.trim(), description.trim())
      onClose()
    } finally {
      setBusy(false)
    }
  }
  // 表单只包住输入区，页眉/页脚保持为 DialogContent 的直接子元素（它按直接子元素决定内边距），
  // 提交按钮用 form 属性关联表单
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg">{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1.5 text-xs text-foreground-muted">
            名称
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：公众号配图" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-foreground-muted">
            说明（可选）
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" form={formId} disabled={!name.trim() || busy}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

export interface PendingAction {
  title: string
  description: string
  /** 真正要执行的动作（切换模板 / 新建模板等） */
  run: () => void | Promise<void>
  /** 当前模板可保存时，提供“保存并继续” */
  save?: () => Promise<void>
}

/** 有未保存修改时的二次确认 */
export function UnsavedConfirm({ pending, onClose }: { pending: PendingAction | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const go = async (withSave: boolean) => {
    if (!pending) return
    setBusy(true)
    try {
      if (withSave && pending.save) await pending.save()
      await pending.run()
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="w-110">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg">{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => go(false)} disabled={busy}>
            放弃修改
          </Button>
          {pending?.save && (
            <Button onClick={() => go(true)} disabled={busy}>
              保存并继续
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 删除等不可撤销操作的确认 */
export function DangerConfirm({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void | Promise<void>
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="w-100">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              await onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
