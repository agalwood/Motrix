import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { useRef, useState } from 'react'
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
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          close()
          setFailed(false)
        }
      }}
    >
      <DialogContent initialFocus={cancel} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {t(`applicationMenu.${request?.kind ?? 'clear'}Title`, {
              count: request?.count,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(`applicationMenu.${request?.kind ?? 'clear'}Description`)}
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
            disabled={busy}
            onClick={() => void confirm()}
          >
            {t(`applicationMenu.${request?.kind ?? 'clear'}Confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
