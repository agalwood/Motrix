import { LoaderCircle, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { TaskOptionsFields } from '@/popup/TaskOptionsFields'
import {
  type QuickAddTaskErrorKind,
  useQuickAddTask,
} from '@/popup/useQuickAddTask'

export const QUICK_ADD_TASK_I18N_KEYS = {
  title: 'popup.quickAdd.title',
  description: 'popup.quickAdd.description',
  inputLabel: 'popup.quickAdd.inputLabel',
  placeholder: 'popup.quickAdd.placeholder',
  cancel: 'popup.quickAdd.cancel',
  add: 'popup.quickAdd.add',
  submitting: 'popup.quickAdd.submitting',
  errors: {
    invalidOptions: 'popup.taskForm.invalidOptions',
    directoryUnavailable: 'popup.taskForm.directoryUnavailable',
    empty: 'popup.quickAdd.error.empty',
    unsupported: 'popup.quickAdd.error.unsupported',
    invalid: 'popup.quickAdd.error.invalid',
    submitFailed: 'popup.quickAdd.error.submitFailed',
    resultUnknown: 'popup.integration.resultUnknown',
    pairingRequired: 'popup.integration.pairingRequired',
    connectionFailed: 'popup.integration.connectionFailed',
    contextChanged: 'popup.integration.contextChanged',
  } satisfies Record<QuickAddTaskErrorKind, string>,
} as const

export interface QuickAddTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pairIfNeeded?: boolean
  onCreated: (taskId: string) => void | Promise<void>
}

export function QuickAddTaskDialog({
  open,
  onOpenChange,
  onCreated,
  pairIfNeeded = false,
}: QuickAddTaskDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const onOpenChangeRef = useRef(onOpenChange)
  const onCreatedRef = useRef(onCreated)

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
    onCreatedRef.current = onCreated
  }, [onCreated, onOpenChange])

  const handleCreated = useCallback(async (taskId: string): Promise<void> => {
    try {
      await onCreatedRef.current(taskId)
    } finally {
      onOpenChangeRef.current(false)
    }
  }, [])

  const controller = useQuickAddTask({ onCreated: handleCreated, pairIfNeeded })
  const previousOpenRef = useRef(open)

  useEffect(() => {
    if (previousOpenRef.current && !open) controller.reset()
    previousOpenRef.current = open
  }, [controller.reset, open])

  const requestOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && controller.submitting) return
    if (!nextOpen) controller.reset()
    onOpenChange(nextOpen)
  }

  const errorId = controller.error ? 'quick-add-task-error' : undefined
  const describedBy = ['quick-add-task-description', errorId]
    .filter(Boolean)
    .join(' ')

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        className="flex max-h-[min(560px,calc(100dvh-24px))] w-[calc(100%-24px)] max-w-[376px] flex-col overflow-hidden gap-4 p-5 sm:max-w-[376px]"
        showCloseButton={false}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          aria-busy={controller.submitting}
          onSubmit={(event) => {
            event.preventDefault()
            void controller.submit()
          }}
        >
          <DialogHeader className="gap-1.5">
            <DialogTitle>{t(QUICK_ADD_TASK_I18N_KEYS.title)}</DialogTitle>
            <DialogDescription
              id="quick-add-task-description"
              className="text-xs/5"
            >
              {t(QUICK_ADD_TASK_I18N_KEYS.description)}
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-3 -my-1 grid min-h-0 min-w-0 grid-cols-1 gap-4 overflow-x-hidden overflow-y-auto px-3 py-1 scroll-py-1">
            <Field data-invalid={controller.error !== null} className="gap-1.5">
              <FieldLabel htmlFor="quick-add-task-input" className="sr-only">
                {t(QUICK_ADD_TASK_I18N_KEYS.inputLabel)}
              </FieldLabel>
              <Textarea
                id="quick-add-task-input"
                dir="ltr"
                className="min-h-[88px] max-h-32 resize-none [overflow-wrap:anywhere]"
                rows={3}
                value={controller.input}
                placeholder={t(QUICK_ADD_TASK_I18N_KEYS.placeholder)}
                autoFocus
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                disabled={controller.submitting}
                aria-invalid={controller.error !== null}
                aria-describedby={describedBy}
                onChange={(event) => controller.setInput(event.target.value)}
              />
              {controller.error && (
                <FieldError id={errorId} aria-live="assertive">
                  {t(QUICK_ADD_TASK_I18N_KEYS.errors[controller.error])}
                </FieldError>
              )}
            </Field>

            <TaskOptionsFields
              value={controller.options}
              onChange={controller.setOptions}
              disabled={controller.submitting}
              magnet={controller.input
                .trim()
                .toLowerCase()
                .startsWith('magnet:')}
            />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {controller.submitting
              ? t(QUICK_ADD_TASK_I18N_KEYS.submitting)
              : ''}
          </p>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={controller.submitting}
              onClick={() => requestOpenChange(false)}
            >
              {t(QUICK_ADD_TASK_I18N_KEYS.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={controller.submitting || !controller.input.trim()}
            >
              {controller.submitting ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Plus data-icon="inline-start" aria-hidden="true" />
              )}
              {controller.submitting
                ? t(QUICK_ADD_TASK_I18N_KEYS.submitting)
                : t(
                    pairIfNeeded
                      ? 'contextMenu.pairThenDownload'
                      : QUICK_ADD_TASK_I18N_KEYS.add
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
