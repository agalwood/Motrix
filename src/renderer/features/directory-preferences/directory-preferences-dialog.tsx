import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { type KeyboardEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DirectoryPreferencesSection,
  DirectoryPreferencesStatus,
} from './directory-preferences-section'
import { useDirectoryPreferencesDraft } from './use-directory-preferences-draft'

export interface DirectoryPreferencesDialogProps {
  open: boolean
  onClose: () => void
}

export function DirectoryPreferencesDialog({
  open,
  onClose,
}: DirectoryPreferencesDialogProps) {
  return open ? <OpenDirectoryPreferencesDialog onClose={onClose} /> : null
}

function OpenDirectoryPreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const draft = useDirectoryPreferencesDraft()
  const [picking, setPicking] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const closed = useRef(false)
  const busy = draft.saving || picking
  const close = () => {
    if (closed.current || busy) return
    closed.current = true
    onClose()
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      return
    }
    const plain =
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (plain && event.repeat && (event.key === 'Enter' || event.key === ' '))
      event.preventDefault()
    if (plain && event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  const save = async () => {
    if (busy || draft.loading || !draft.ready) return
    contentRef.current?.focus({ preventScroll: true })
    if (await draft.save()) close()
  }
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open) return
        if (busy) details.cancel()
        else close()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={contentRef}
        onKeyDown={keyDown}
        onKeyUp={(event) => event.stopPropagation()}
        className="flex max-h-[min(520px,calc(100dvh-2rem))] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]"
        data-testid="directory-preferences-dialog"
      >
        <DialogHeader className="shrink-0 gap-2 border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {t('directoryPreferences.title')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('directoryPreferences.description')}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={contentRef}
          tabIndex={-1}
          aria-busy={busy || draft.loading}
          data-testid="directory-preferences-content"
          className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 outline-none"
        >
          <DirectoryPreferencesStatus
            loading={draft.loading}
            error={draft.error}
            disabled={busy}
            onRetry={() => {
              contentRef.current?.focus({ preventScroll: true })
              void draft.refresh()
            }}
          />
          <DirectoryPreferencesSection
            preferences={draft.preferences}
            onChange={draft.setPreferences}
            disabled={draft.loading || busy || !draft.ready}
            onPickingChange={setPicking}
          />
        </div>
        <DialogFooter className="shrink-0 flex-row justify-end border-t px-4 py-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={close}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || draft.loading || !draft.ready}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
