import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TaskOptionsFields } from '@/popup/TaskOptionsFields'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import {
  CONFIRMATION_PORT,
  type ConfirmationDecision,
  type DownloadConfirmation,
} from '@/shared/downloadConfirmation'
import { DOWNLOAD_ERROR, type DownloadErrorReason } from '@/shared/integration'
import { supportsBrowserDownload } from '@/shared/platformCapabilities'
import { isMagnetUrl } from '@/shared/takeover'
import { taskOptionsSchema } from '@/shared/taskOptions'

export function DownloadConfirmationDialog() {
  const [draft, setDraft] = useState<DownloadConfirmation | null>(null)
  const portRef = useRef<Browser.runtime.Port | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    let port: Browser.runtime.Port | undefined
    void (async () => {
      const window = await browser.windows.getCurrent()
      if (disposed || window.id === undefined) return
      port = browser.runtime.connect({ name: CONFIRMATION_PORT })
      portRef.current = port
      port.onMessage.addListener(
        (message: { draft?: DownloadConfirmation | null }) => {
          if (!disposed && 'draft' in message) setDraft(message.draft ?? null)
        }
      )
      port.onDisconnect.addListener(() => {
        if (!disposed) setDraft(null)
      })
      port.postMessage({ windowId: window.id })
      // Traffic, rather than merely holding a port, keeps the MV3 worker alive.
      timer = setInterval(() => {
        try {
          port?.postMessage({ heartbeat: true })
        } catch {
          /* Closed view. */
        }
      }, 20_000)
    })().catch(() => {})
    return () => {
      disposed = true
      clearInterval(timer)
      portRef.current = null
      port?.disconnect()
    }
  }, [])
  if (!draft) return null
  return (
    <ConfirmationForm
      key={draft.id}
      draft={draft}
      onDismiss={() => setDraft(null)}
      onDecide={(decision) => {
        try {
          portRef.current?.postMessage({ id: draft.id, decision })
        } catch {
          setDraft(null)
        }
      }}
    />
  )
}

function ConfirmationForm({
  draft,
  onDecide,
  onDismiss,
}: {
  draft: DownloadConfirmation
  onDecide: (decision: ConfirmationDecision) => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const [options, setOptions] = useState(draft.options)
  const [invalid, setInvalid] = useState(false)
  const [submittedDraft, setSubmittedDraft] =
    useState<DownloadConfirmation | null>(null)
  const [remaining, setRemaining] = useState(
    Math.ceil((draft.expiresAt - Date.now()) / 1000)
  )
  useEffect(() => {
    const update = () =>
      setRemaining(
        Math.max(0, Math.ceil((draft.expiresAt - Date.now()) / 1000))
      )
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [draft.expiresAt])
  const sending = submittedDraft === draft || draft.phase === 'submitting'
  const disabled = sending || draft.phase === 'unknown' || remaining <= 0
  const browserDownloadContinues =
    draft.target.origin === 'auto' && !draft.target.nativeDownloadCancelled
  const browserAllowed =
    !isMagnetUrl(draft.target.url) &&
    (draft.target.origin === 'auto' || supportsBrowserDownload())
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <DialogContent
        className="flex max-h-[min(560px,calc(100dvh-24px))] w-[calc(100%-24px)] max-w-[376px] flex-col overflow-hidden p-5 sm:max-w-[376px]"
        showCloseButton={false}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = taskOptionsSchema.safeParse(options)
            setInvalid(!parsed.success)
            if (!parsed.success || disabled) return
            setSubmittedDraft(draft)
            onDecide({ action: 'submit', options: parsed.data })
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('options.downloadMode.confirm')}</DialogTitle>
            <DialogDescription className="text-xs/5">
              {t(
                draft.target.origin === 'auto'
                  ? draft.target.nativeDownloadCancelled
                    ? 'popup.confirmDownload.earlyInterceptedDescription'
                    : 'popup.confirmDownload.interceptedDescription'
                  : 'popup.confirmDownload.description'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-3 -my-1 grid min-h-0 min-w-0 grid-cols-1 gap-4 overflow-x-hidden overflow-y-auto px-3 py-1 scroll-py-1">
            <div className="grid min-w-0 gap-1.5">
              <label htmlFor="confirmation-url" className="text-xs font-medium">
                {t('popup.quickAdd.inputLabel')}
              </label>
              <textarea
                id="confirmation-url"
                dir="ltr"
                readOnly
                rows={3}
                value={draft.target.url}
                className="min-w-0 w-full resize-none rounded-md border bg-muted/30 p-2 text-xs [overflow-wrap:anywhere]"
              />
            </div>
            <TaskOptionsFields
              value={options}
              onChange={(value) => {
                setOptions(value)
                setInvalid(false)
                onDecide({ action: 'edit', options: value })
              }}
              disabled={disabled}
              magnet={isMagnetUrl(draft.target.url)}
              browserCookies
            />
          </div>
          {invalid && (
            <p role="alert" className="shrink-0 text-xs text-destructive">
              {t('popup.taskForm.invalidOptions')}
            </p>
          )}
          {draft.error && (
            <p role="alert" className="shrink-0 text-xs text-destructive">
              {t(confirmationErrorKey(draft.error))}
            </p>
          )}
          {browserAllowed && !browserDownloadContinues && (
            <p
              id="confirmation-browser-hint"
              className="shrink-0 text-xs text-muted-foreground"
            >
              {t('popup.confirmDownload.browserHint')}
            </p>
          )}
          <p className="shrink-0 text-xs text-muted-foreground">
            {sending
              ? t('popup.quickAdd.submitting')
              : t('popup.confirmDownload.expires', { seconds: remaining })}
          </p>
          <DialogFooter className="shrink-0 flex-wrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onDecide({ action: 'cancel' })}
            >
              {t(
                sending || draft.phase === 'unknown'
                  ? 'popup.confirmDownload.close'
                  : 'popup.quickAdd.cancel'
              )}
            </Button>
            {browserAllowed && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-describedby={
                  browserDownloadContinues
                    ? undefined
                    : 'confirmation-browser-hint'
                }
                onClick={() => {
                  setSubmittedDraft(draft)
                  onDecide({ action: 'browser' })
                }}
              >
                {t(
                  browserDownloadContinues
                    ? 'popup.confirmDownload.keepBrowser'
                    : 'popup.confirmDownload.browser'
                )}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={disabled}>
              {t('popup.quickAdd.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function confirmationErrorKey(error: DownloadErrorReason): string {
  switch (error) {
    case DOWNLOAD_ERROR.directoryUnavailable:
      return 'popup.taskForm.directoryUnavailable'
    case DOWNLOAD_ERROR.resultUnknown:
      return 'popup.integration.resultUnknown'
    case DOWNLOAD_ERROR.endpointChanged:
    case DOWNLOAD_ERROR.contextChanged:
      return 'popup.integration.contextChanged'
    case DOWNLOAD_ERROR.pairingRequired:
      return 'popup.integration.pairingRequired'
    case DOWNLOAD_ERROR.connectionFailed:
    case DOWNLOAD_ERROR.preparationTimeout:
      return 'popup.integration.connectionFailed'
    default:
      return 'popup.quickAdd.error.submitFailed'
  }
}
