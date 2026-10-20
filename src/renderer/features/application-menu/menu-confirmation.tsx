import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useExitSnapshot } from '@renderer/hooks/use-exit-snapshot'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface MenuConfirmationRequest {
  kind: 'clear' | 'logout' | 'discard'
  count?: number
  run: () => Promise<void>
}
export function MenuConfirmation({
  request,
  close,
}: {
  request: MenuConfirmationRequest | null
  close: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const open = request !== null
  const presentation = useExitSnapshot(open, request)
  useLayoutEffect(() => {
    if (open) setFailed(false)
  }, [open])
  const pending = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const session = useOperatorSession((state) => state.state)
  const confirm = async () => {
    if (pending.current || !request || session === 'logging-out') return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      await request.run()
      close()
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open && !busy) {
          close()
        }
      }}
    >
      <DialogContent initialFocus={cancel} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {t(`applicationMenu.${presentation?.kind ?? 'clear'}Title`, {
              count: presentation?.count,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(`applicationMenu.${presentation?.kind ?? 'clear'}Description`)}
          </DialogDescription>
        </DialogHeader>
        {failed && (
          <p role="alert" className="text-destructive">
            {t('applicationMenu.actionFailed')}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancel} variant="ghost" disabled={busy} onClick={close}>
            {t('panel.downloads.action.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !open}
            onClick={() => void confirm()}
          >
            {t(`applicationMenu.${presentation?.kind ?? 'clear'}Confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
