import { zodResolver } from '@hookform/resolvers/zod'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import type { ParsedTorrentFile } from '@renderer/lib/parse-torrent-file'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type AddTaskFormValues,
  addTaskFormSchema,
  formValuesToTaskCreateRequests,
  type TaskCreateCommandResult,
  type TaskCreateRequest,
  type TorrentBatchCreateOptions,
  type TorrentBatchCreateResult,
  type TorrentQueueAdvanceResult,
} from '@shared/schemas/add-task'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DeepPartial,
  FormProvider,
  type Resolver,
  useForm,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AddTaskLayoutProvider } from './add-task-layout-context'
import { FooterActions } from './footer-actions'
import { LinksTabPanel } from './links-tab-panel'
import { TorrentTabPanel } from './torrent-tab-panel'
import { parseUrlLines } from './url-interpreters/multiline-url'
import {
  type AddTaskModeHydrationContext,
  type TorrentQueueState,
  type TorrentQueueUpdate,
  useExternalHydration,
} from './use-external-hydration'

interface AddTaskFormProps {
  defaultValues?: DeepPartial<AddTaskFormValues>
  onSubmitSuccess?: (taskId: string) => void
  onCancel: () => void
  onAdvancedOpenChange?: (expanded: boolean) => void
  presentation?: 'dialog' | 'window'
  subscribeEvents?: boolean
}

const BASE_DEFAULTS: DeepPartial<AddTaskFormValues> = {
  tab: 'links',
  urls: '',
  saveDir: '',
}

interface LocalTorrentQueue {
  files: ParsedTorrentFile[]
  currentIndex: number
}

function taskCreateFailureReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const reason = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^(?:AppError|Error):\s*/u, '')
    .trim()
  return reason || null
}

export function AddTaskForm({
  defaultValues,
  onSubmitSuccess,
  onCancel,
  onAdvancedOpenChange,
  presentation = 'window',
  subscribeEvents = true,
}: AddTaskFormProps) {
  const platform = usePlatformServices()
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [advancingTorrent, setAdvancingTorrent] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [torrentQueue, setTorrentQueue] = useState<TorrentQueueState | null>(
    null
  )
  const [localTorrentQueue, setLocalTorrentQueue] =
    useState<LocalTorrentQueue | null>(null)
  const [duplicateConflict, setDuplicateConflict] = useState<{
    request: TaskCreateRequest
    result: Extract<TaskCreateCommandResult, { outcome: 'conflict' }>
  } | null>(null)

  const form = useForm<AddTaskFormValues>({
    resolver: zodResolver(addTaskFormSchema) as Resolver<AddTaskFormValues>,
    mode: 'onTouched',
    defaultValues: { ...BASE_DEFAULTS, ...defaultValues } as AddTaskFormValues,
  })

  const openHydrationRequest = useRef(0)

  // Refresh open-scoped settings for each actual open. The desktop add-task
  // window is precreated while hidden, so its mount-time default directory can
  // be stale by the time the user opens it. In-page dialogs are already visible
  // when this form mounts and only need clipboard hydration here.
  const hydrateOpenState = useCallback(
    async (context?: AddTaskModeHydrationContext) => {
      const request = ++openHydrationRequest.current
      try {
        const settings = (await transport.invoke(Queries.GetSettings)) as {
          app?: {
            autofillClipboardLinks?: boolean
            defaultSaveDir?: string
          }
        }
        if (request !== openHydrationRequest.current) return

        if (
          context?.refreshDefaultSaveDir &&
          !form.getFieldState('saveDir').isDirty &&
          typeof settings?.app?.defaultSaveDir === 'string'
        ) {
          form.setValue(
            'saveDir' as never,
            settings.app.defaultSaveDir as never,
            { shouldDirty: false, shouldValidate: false }
          )
        }

        if (form.getValues('tab') !== 'links') return
        if (form.getValues('urls')) return
        if (settings?.app?.autofillClipboardLinks === false) return

        const content = (await platform.readClipboard()).trim()
        if (request !== openHydrationRequest.current || !content) return
        const lines = parseUrlLines(content)
        if (lines.length === 0 || !lines.every((line) => line.valid)) return
        if (form.getValues('urls')) return
        form.setValue(
          'urls' as never,
          lines.map((line) => line.url).join('\n') as never,
          { shouldValidate: true }
        )
      } catch {
        // Best effort — local defaults keep the form usable and the clipboard
        // may be unreadable under web permissions.
      }
    },
    [form, platform]
  )

  const handleTorrentQueueChanged = useCallback(
    (update: TorrentQueueUpdate) => {
      setLocalTorrentQueue(null)
      if (!update) {
        setTorrentQueue(null)
        setAdvancingTorrent(false)
        return
      }
      setTorrentQueue((current) => ({
        queuePosition:
          'queuePosition' in update
            ? update.queuePosition
            : (current?.queuePosition ?? 1),
        queueTotal: update.queueTotal,
      }))
      if ('queuePosition' in update) setAdvancingTorrent(false)
    },
    []
  )

  const hydrateLocalTorrent = useCallback(
    (torrent: ParsedTorrentFile) => {
      form.setValue('tab' as never, 'torrent' as never, { shouldDirty: true })
      form.setValue('torrentMeta' as never, torrent.meta as never, {
        shouldDirty: true,
      })
      form.setValue('source' as never, 'file' as never, { shouldDirty: true })
      form.setValue('base64' as never, torrent.base64 as never, {
        shouldDirty: true,
      })
      form.setValue('magnetUri' as never, undefined as never, {
        shouldDirty: true,
      })
      form.setValue(
        'selectedFiles' as never,
        torrent.meta.files.map((file) => file.index) as never,
        { shouldDirty: true, shouldValidate: true }
      )
    },
    [form]
  )

  const handleLocalTorrentFilesLoaded = useCallback(
    (files: ParsedTorrentFile[]) => {
      if (files.length === 0) return
      setLocalTorrentQueue({ files, currentIndex: 0 })
      setTorrentQueue(
        files.length > 1 ? { queuePosition: 1, queueTotal: files.length } : null
      )
      setAdvancingTorrent(false)
    },
    []
  )

  useExternalHydration(
    form,
    subscribeEvents,
    hydrateOpenState,
    handleTorrentQueueChanged
  )

  // Backfill the default save directory for the initially mounted form.
  // Desktop opens refresh it again through hydrateOpenState above.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const settings = (await transport.invoke(Queries.GetSettings)) as {
          app?: { defaultSaveDir?: string }
        }
        const dir = settings?.app?.defaultSaveDir
        if (!cancelled && dir && !form.getValues('saveDir')) {
          form.setValue('saveDir' as never, dir as never, {
            shouldValidate: false,
          })
        }
      } catch {
        // Best effort — local defaults keep the form usable.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  // Only immediately visible in-page dialogs read the clipboard on mount.
  // Desktop opens are triggered after SetAddTaskMode resets the precreated
  // form, so precreation never accesses the clipboard and external prefill wins.
  useEffect(() => {
    if (!subscribeEvents) void hydrateOpenState()
    return () => {
      openHydrationRequest.current += 1
    }
  }, [hydrateOpenState, subscribeEvents])

  const hasNextQueuedTorrent = useCallback(
    () =>
      Boolean(
        torrentQueue && torrentQueue.queuePosition < torrentQueue.queueTotal
      ),
    [torrentQueue]
  )

  const advanceTorrentQueue = useCallback(async () => {
    setAdvancingTorrent(true)
    if (localTorrentQueue) {
      const nextIndex = localTorrentQueue.currentIndex + 1
      const next = localTorrentQueue.files[nextIndex]
      if (!next) {
        setLocalTorrentQueue(null)
        setTorrentQueue(null)
        setAdvancingTorrent(false)
        return false
      }
      hydrateLocalTorrent(next)
      setLocalTorrentQueue({ ...localTorrentQueue, currentIndex: nextIndex })
      setTorrentQueue({
        queuePosition: nextIndex + 1,
        queueTotal: localTorrentQueue.files.length,
      })
      setAdvancingTorrent(false)
      return true
    }
    try {
      const result = (await transport.invoke(
        Commands.NextTorrent
      )) as TorrentQueueAdvanceResult
      if (!result.advanced) {
        setTorrentQueue(null)
        setAdvancingTorrent(false)
      }
      return result.advanced
    } catch (error) {
      console.error(error)
      setAdvancingTorrent(false)
      platform.notify('error', 'task.add.queueAdvanceFailed')
      return true
    }
  }, [hydrateLocalTorrent, localTorrentQueue, platform])

  const completeCurrentSubmission = useCallback(
    async (taskId: string) => {
      const values = form.getValues()
      if (
        hasNextQueuedTorrent() &&
        values.tab === 'torrent' &&
        values.source === 'file'
      ) {
        if (await advanceTorrentQueue()) return
      }
      setLocalTorrentQueue(null)
      setTorrentQueue(null)
      onSubmitSuccess?.(taskId)
    },
    [advanceTorrentQueue, form, hasNextQueuedTorrent, onSubmitSuccess]
  )

  const handleCancel = useCallback(async () => {
    if (hasNextQueuedTorrent()) {
      if (await advanceTorrentQueue()) return
    }
    onCancel()
  }, [advanceTorrentQueue, hasNextQueuedTorrent, onCancel])

  const handleDownloadAllTorrents = useCallback(async () => {
    if (!hasNextQueuedTorrent()) return
    setBatchSubmitting(true)
    try {
      const parsedValues = addTaskFormSchema.safeParse(form.getValues())
      if (!parsedValues.success) return
      const values = parsedValues.data
      if (values.tab !== 'torrent' || values.source !== 'file') return
      const currentRequest = formValuesToTaskCreateRequests(values)[0]
      if (currentRequest?.type !== 'bt') return

      let result: TorrentBatchCreateResult
      if (localTorrentQueue) {
        const requests: TaskCreateRequest[] = [
          currentRequest,
          ...localTorrentQueue.files
            .slice(localTorrentQueue.currentIndex + 1)
            .map((torrent) => ({
              type: 'bt' as const,
              payload: {
                kind: 'torrent-base64' as const,
                base64: torrent.base64,
              },
              selectedFiles: torrent.meta.files.map((file) => file.index),
              saveDir: values.saveDir,
              dlLimit: values.dlLimit,
              ulLimit: values.ulLimit,
              seedRatio: values.seedRatio,
              displayName: torrent.meta.name,
            })),
        ]
        let succeeded = 0
        let failed = 0
        let firstTaskId: string | null = null
        for (const request of requests) {
          try {
            const created = (await transport.invoke(
              Commands.CreateTask,
              request
            )) as TaskCreateCommandResult
            if (created.outcome === 'conflict') {
              failed += 1
              continue
            }
            succeeded += 1
            firstTaskId ??= created.taskId ?? created.gid
          } catch (error) {
            console.error(error)
            failed += 1
          }
        }
        result = {
          total: requests.length,
          succeeded,
          failed,
          firstTaskId,
        }
      } else {
        const options: TorrentBatchCreateOptions = {
          selectedFiles: values.selectedFiles,
          saveDir: currentRequest.saveDir,
          dlLimit: currentRequest.dlLimit,
          ulLimit: currentRequest.ulLimit,
          seedRatio: currentRequest.seedRatio,
        }
        result = (await transport.invoke(
          Commands.DownloadAllTorrents,
          options
        )) as TorrentBatchCreateResult
      }
      setLocalTorrentQueue(null)
      setTorrentQueue(null)
      if (result.succeeded > 0) {
        if (result.failed > 0) {
          platform.notify('warn', 'task.add.createdPartial', {
            ok: result.succeeded,
            failed: result.failed,
          })
        } else {
          platform.notify('info', 'task.add.batchCreated', {
            count: result.succeeded,
          })
        }
        if (result.firstTaskId) onSubmitSuccess?.(result.firstTaskId)
      } else {
        platform.notify('error', 'task.add.createFailed')
      }
    } catch (error) {
      console.error(error)
      platform.notify('error', 'task.add.createFailed')
    } finally {
      setBatchSubmitting(false)
    }
  }, [form, hasNextQueuedTorrent, localTorrentQueue, onSubmitSuccess, platform])

  const onSubmit = useCallback(
    async (values: AddTaskFormValues) => {
      if (submitting || advancingTorrent || batchSubmitting) return
      setSubmitting(true)
      try {
        const requests = formValuesToTaskCreateRequests(values)
        const successes: Array<
          Extract<TaskCreateCommandResult, { gid: string }>
        > = []
        let failed = 0
        let firstFailureReason: string | null = null
        let blockedByConflict = false
        for (const request of requests) {
          try {
            const result = (await transport.invoke(
              Commands.CreateTask,
              request
            )) as TaskCreateCommandResult
            if (result.outcome === 'conflict') {
              setDuplicateConflict({ request, result })
              blockedByConflict = true
              break
            }
            successes.push(result)
          } catch (err) {
            failed += 1
            firstFailureReason ??= taskCreateFailureReason(err)
            console.error(err)
          }
        }
        if (blockedByConflict) return
        if (failed === 0 && successes.length > 0) {
          platform.notify('info', 'task.add.created')
        } else if (successes.length > 0) {
          platform.notify('warn', 'task.add.createdPartial', {
            ok: successes.length,
            failed,
          })
        } else if (failed > 0) {
          if (firstFailureReason) {
            platform.notify('error', 'task.add.createFailedWithReason', {
              reason: firstFailureReason,
            })
          } else {
            platform.notify('error', 'task.add.createFailed')
          }
        }
        if (successes.length > 0) {
          await completeCurrentSubmission(
            successes[0].taskId ?? successes[0].gid
          )
        }
      } finally {
        setSubmitting(false)
      }
    },
    [
      advancingTorrent,
      batchSubmitting,
      completeCurrentSubmission,
      platform,
      submitting,
    ]
  )

  const createSeparateCopy = useCallback(async () => {
    if (!duplicateConflict) return
    setSubmitting(true)
    try {
      const result = (await transport.invoke(Commands.CreateTask, {
        ...duplicateConflict.request,
        duplicatePolicy: 'create-copy',
      })) as TaskCreateCommandResult
      if (result.outcome === 'conflict') {
        setDuplicateConflict({ request: duplicateConflict.request, result })
        return
      }
      setDuplicateConflict(null)
      platform.notify('info', 'task.add.createdCopy')
      await completeCurrentSubmission(result.taskId)
    } catch (error) {
      console.error(error)
      const reason = taskCreateFailureReason(error)
      if (reason) {
        platform.notify('error', 'task.add.createFailedWithReason', { reason })
      } else {
        platform.notify('error', 'task.add.createFailed')
      }
    } finally {
      setSubmitting(false)
    }
  }, [completeCurrentSubmission, duplicateConflict, platform])

  // ⌘↵ / Ctrl+Enter submit
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void form.handleSubmit(onSubmit)()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [form, onSubmit])

  return (
    <AddTaskLayoutProvider onAdvancedOpenChange={onAdvancedOpenChange}>
      <FormProvider {...form}>
        <div
          data-slot="add-task-form-body"
          className={cn(
            'flex flex-col overflow-y-auto',
            presentation === 'dialog'
              ? 'min-h-0 flex-auto'
              : 'max-h-[calc(100vh-40px)]'
          )}
        >
          <div
            data-adaptive-content
            className={cn(
              'px-4 pt-2',
              presentation === 'dialog' ? 'pb-4' : 'pb-[72px]'
            )}
          >
            <TabsSection onTorrentFilesLoaded={handleLocalTorrentFilesLoaded} />
          </div>
        </div>
        <div
          data-slot="add-task-form-footer"
          className={cn(
            'w-full shrink-0 border-t-[0.5px] border-border bg-background px-4 py-3',
            presentation === 'window' && 'fixed bottom-0 left-0'
          )}
        >
          <FooterActionsBridge
            onCancel={() => void handleCancel()}
            onDownloadAll={handleDownloadAllTorrents}
            onSubmit={() => void form.handleSubmit(onSubmit)()}
            submitting={submitting || advancingTorrent || batchSubmitting}
            torrentQueue={torrentQueue}
          />
        </div>
        <AlertDialog
          open={duplicateConflict !== null}
          onOpenChange={(open) => !open && setDuplicateConflict(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('task.add.duplicate.title')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  `task.add.duplicate.${duplicateConflict?.result.conflict.reason}`,
                  {
                    name:
                      duplicateConflict?.result.conflict.existingTaskName ??
                      t('task.add.duplicate.filesOnDisk'),
                  }
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              {duplicateConflict?.result.conflict.existingTaskId && (
                <AlertDialogAction
                  onClick={() => {
                    const taskId =
                      duplicateConflict.result.conflict.existingTaskId
                    setDuplicateConflict(null)
                    if (taskId) void completeCurrentSubmission(taskId)
                  }}
                >
                  {t('task.add.duplicate.showExisting')}
                </AlertDialogAction>
              )}
              {duplicateConflict?.result.conflict.canCreateCopy && (
                <AlertDialogAction onClick={() => void createSeparateCopy()}>
                  {t('task.add.duplicate.createCopy')}
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </FormProvider>
    </AddTaskLayoutProvider>
  )
}

function TabsSection({
  onTorrentFilesLoaded,
}: {
  onTorrentFilesLoaded: (files: ParsedTorrentFile[]) => void
}) {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  return (
    <Tabs
      value={tab ?? 'links'}
      onValueChange={(v) =>
        setValue('tab' as never, v as never, { shouldDirty: true })
      }
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="shrink-0 bg-tab-background">
        <TabsTrigger value="links">{t('task.add.links')}</TabsTrigger>
        <TabsTrigger value="torrent">{t('task.add.torrent')}</TabsTrigger>
      </TabsList>
      <TabsContent
        value="links"
        keepMounted
        className="mt-2 flex min-h-0 min-w-0 flex-1 data-hidden:hidden"
      >
        <LinksTabPanel />
      </TabsContent>
      <TabsContent
        value="torrent"
        keepMounted
        className="mt-2 flex min-h-0 min-w-0 flex-1 data-hidden:hidden"
      >
        <TorrentTabPanel onFilesLoaded={onTorrentFilesLoaded} />
      </TabsContent>
    </Tabs>
  )
}

function FooterActionsBridge({
  onCancel,
  onDownloadAll,
  onSubmit,
  submitting,
  torrentQueue,
}: {
  onCancel: () => void
  onDownloadAll: () => void
  onSubmit: () => void
  submitting: boolean
  torrentQueue: TorrentQueueState | null
}) {
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  const urls = useWatch<AddTaskFormValues, 'urls'>({ name: 'urls' })
  const saveDir = useWatch<AddTaskFormValues, 'saveDir'>({ name: 'saveDir' })
  const selectedFiles = useWatch<AddTaskFormValues, 'selectedFiles'>({
    name: 'selectedFiles',
  })
  const torrentMeta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })

  const hasSaveDir = Boolean((saveDir ?? '').trim())
  const canSubmit =
    hasSaveDir &&
    (tab === 'links'
      ? Boolean((urls ?? '').trim())
      : Boolean(torrentMeta) && (selectedFiles ?? []).length > 0)

  return (
    <FooterActions
      submitting={submitting}
      canSubmit={canSubmit}
      torrentQueue={
        torrentQueue
          ? {
              current: torrentQueue.queuePosition,
              total: torrentQueue.queueTotal,
            }
          : undefined
      }
      onCancel={onCancel}
      onDownloadAll={onDownloadAll}
      onSubmit={onSubmit}
    />
  )
}
