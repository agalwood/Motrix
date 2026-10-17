import { validateOperationValues } from '@motrix/plugin-manifest-schema'
import { CheckIcon, RevealFolderIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { invokeOperation } from '@renderer/features/plugin-operations/operation-client'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type { FilePickerOptions } from '@shared/schemas/file-picker'
import {
  isOperationTerminal,
  type OperationDescriptor,
  type OperationDraft,
  type OperationJob,
} from '@shared/schemas/plugin-operations'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { OperationFields } from './operation-fields'
import { OperationIcon } from './operation-icon'
import { OperationSkeleton } from './operation-skeleton'
import {
  type OperationRequest,
  type OperationSession,
  operationSessionKey,
  useOperationSessions,
} from './operation-store'
import { useOperationState } from './use-operation-state'

type OperationFormProps = OperationRequest & { onClose?: () => void }

function operationErrorKey(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).match(
      /pluginOperations\.[A-Za-z]+/
    )?.[0] ?? 'pluginOperations.failed'
  )
}

export default function OperationForm(props: OperationFormProps) {
  const { t } = useTranslation()
  const { snapshot, failed, retry } = useOperationState()
  const descriptor = snapshot?.descriptors.find(
    (item) =>
      item.pluginId === props.pluginId &&
      item.definition.id === props.operationId
  )
  if (!snapshot && !failed) return <OperationSkeleton />
  if (!descriptor)
    return (
      <div role="status" className="space-y-3">
        <p>
          {t(
            failed
              ? 'pluginOperations.failed'
              : snapshot
                ? 'pluginOperations.unavailable'
                : 'pluginOperations.loading'
          )}
        </p>
        {(failed || snapshot) && (
          <Button size="sm" onClick={retry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    )
  const sessionKey = operationSessionKey(props)
  const cached = useOperationSessions.getState().sessions[sessionKey]
  const revision = cached?.draft?.descriptor ?? cached?.descriptor
  // Journals preserve active work and interruption warnings, not completed forms.
  // Completed results survive navigation in this renderer, never app restart.
  const session =
    revision?.descriptorRevision === descriptor.descriptorRevision
      ? cached
      : undefined
  const latestJob = snapshot?.jobs
    ?.filter(
      (job) =>
        job.pluginId === props.pluginId && job.operationId === props.operationId
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  const recoverableJob =
    latestJob &&
    (!isOperationTerminal(latestJob.status) ||
      latestJob.status === 'interrupted')
      ? latestJob
      : undefined
  if (descriptor.unavailable && !recoverableJob)
    return (
      <p role="status">{t(`pluginOperations.${descriptor.unavailable}`)}</p>
    )
  return (
    <OperationFormContent
      key={`${sessionKey}:${descriptor.descriptorRevision}`}
      {...props}
      descriptor={descriptor}
      initialSession={session ?? { descriptor, job: recoverableJob }}
    />
  )
}

function OperationFormContent({
  onClose,
  descriptor: loadedDescriptor,
  initialSession: session,
  ...request
}: OperationFormProps & {
  descriptor: OperationDescriptor
  initialSession: OperationSession
}) {
  const { t } = useTranslation()
  const sessionKey = operationSessionKey(request)
  const [draft, setDraft] = useState<OperationDraft | undefined>(session.draft)
  const [job, setJob] = useState<OperationJob | undefined>(session?.job)
  const [pending, setPending] = useState(false)
  const [updatingDraft, setUpdatingDraft] = useState(false)
  const [resumingDraft, setResumingDraft] = useState(!!session.draftUpdate)
  const draftUpdate = useRef(session.draftUpdate ?? null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancelRequested = useRef(false)
  const [error, setError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const platform = usePlatformServices()
  const form = useForm<Record<string, string | number | boolean>>({
    defaultValues: session?.values ?? session?.draft?.args ?? {},
  })
  const values = form.watch()
  const running = !!job && !isOperationTerminal(job.status)
  const blocked = pending || running || !!job || !draft
  const save = useCallback(
    (
      patch: Parameters<
        ReturnType<typeof useOperationSessions.getState>['save']
      >[1]
    ) => {
      const store = useOperationSessions.getState()
      if (
        store.sessions[sessionKey]?.descriptor?.descriptorRevision ===
        loadedDescriptor.descriptorRevision
      )
        store.save(sessionKey, patch)
    },
    [sessionKey, loadedDescriptor.descriptorRevision]
  )
  const report = useCallback((e: unknown) => setError(operationErrorKey(e)), [])
  const prepare = useCallback(
    async (repeatJobId?: string, resume = false) => {
      if (inFlight.current) return
      inFlight.current = true
      setPending(true)
      setError('')
      try {
        const previous = useOperationSessions.getState().sessions[sessionKey]
        if (previous?.draft && !previous.job)
          await invokeOperation(
            Commands.DiscardPluginOperation,
            previous.draft.id
          ).catch(() => undefined)
        const next = await invokeOperation<OperationDraft>(
          Commands.PreparePluginOperation,
          (() => {
            const [pluginId, operationId, taskIds] = JSON.parse(sessionKey) as [
              string,
              string,
              string[],
            ]
            return {
              pluginId,
              operationId,
              taskIds: previous?.job ? [] : taskIds,
              ...(repeatJobId ? { repeatJobId } : {}),
              ...(resume ? { resume: true } : {}),
            }
          })()
        )
        save({
          descriptor: next.descriptor,
          draft: next,
          values: next.args,
          job: undefined,
          key: undefined,
        })
        if (mounted.current) {
          setDraft(next)
          form.reset(next.args)
          setJob(undefined)
        }
      } catch (e) {
        if (repeatJobId) {
          // A failed reauthorization must leave a path back to a fresh selection.
          save({
            draft: undefined,
            job: undefined,
            values: undefined,
            key: undefined,
          })
          if (mounted.current) {
            setDraft(undefined)
            setJob(undefined)
          }
        }
        if (mounted.current) report(e)
      } finally {
        inFlight.current = false
        if (mounted.current) setPending(false)
      }
    },
    [form, report, save, sessionKey]
  )
  const initialized = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    useOperationSessions.getState().replace(sessionKey, {
      ...session,
      descriptor: loadedDescriptor,
    })
    if (session.draftUpdate) {
      // A closed form can still be updating the host. Reopen only after its
      // confirmed file references and latest values have reached the session.
      void session.draftUpdate.then((failure) => {
        if (!mounted.current) return
        const latest = useOperationSessions.getState().sessions[sessionKey]
        setDraft(latest?.draft)
        form.reset(latest?.values ?? latest?.draft?.args ?? {})
        draftUpdate.current = null
        setResumingDraft(false)
        if (failure) report(failure)
      })
      return
    }
    if ((!draft || draft.expiresAt < Date.now()) && !job)
      void prepare(undefined, true)
  }, [draft, form, job, loadedDescriptor, prepare, report, session, sessionKey])
  // Localization updates presentation without changing the revision or grants.
  useEffect(() => {
    save({ descriptor: loadedDescriptor })
  }, [loadedDescriptor, save])
  useEffect(() => {
    const subscription = form.watch((value) =>
      save({ values: value as Record<string, string | number | boolean> })
    )
    return () => subscription.unsubscribe()
  }, [form, save])
  const jobId = job?.id
  const terminal = !!job && isOperationTerminal(job.status)
  useEffect(() => {
    if (!jobId || terminal) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await invokeOperation<OperationJob>(
          Commands.GetPluginOperationJob,
          jobId
        )
        if (active) {
          setJob(next)
          save({ job: next })
        }
        if (active && !isOperationTerminal(next.status))
          timer = setTimeout(refresh, 500)
      } catch (e) {
        if (active) {
          report(e)
          timer = setTimeout(refresh, 2000)
        }
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [jobId, terminal, save, report])
  const acceptDraft = (next: OperationDraft) => {
    if (mounted.current) {
      setDraft(next)
      form.reset(next.args)
    }
    save({ draft: next, values: next.args, key: undefined })
  }
  const change = (field: string, value: string | number | boolean) => {
    if (!draft || inFlight.current) return
    if (form.getValues(field) === value) return
    form.setValue(field, value, { shouldDirty: true })
    save({ key: undefined })
    const files = draft.descriptor.definition.files ?? {}
    const extensionFields = Object.values(files).flatMap((binding) =>
      binding.kind === 'output-file' && binding.extensionFrom
        ? [binding.extensionFrom]
        : []
    )
    if (!extensionFields.includes(field) || draftUpdate.current) return

    // Synchronize formats without flashing the whole form's disabled styles.
    // Each response must settle before another update touches the host draft.
    setUpdatingDraft(true)
    setError('')
    draftUpdate.current = (async () => {
      let confirmed = draft
      try {
        let submitted: typeof values
        do {
          submitted = { ...form.getValues() }
          confirmed = await invokeOperation<OperationDraft>(
            Commands.UpdatePluginOperationDraft,
            { draftId: draft.id, values: submitted }
          )
        } while (
          extensionFields.some((key) => form.getValues(key) !== submitted[key])
        )
        return undefined
      } catch (e) {
        if (mounted.current) report(e)
        return operationErrorKey(e)
      } finally {
        // Keep unrelated edits made during the request. File references and
        // their formats always come from the last confirmed host draft.
        const nextValues = { ...form.getValues() }
        for (const key of [...Object.keys(files), ...extensionFields]) {
          delete nextValues[key]
          if (confirmed.args[key] !== undefined)
            nextValues[key] = confirmed.args[key]
        }
        if (mounted.current) {
          setDraft(confirmed)
          form.reset(nextValues, {
            keepErrors: true,
            keepDirty: true,
            keepTouched: true,
          })
          setUpdatingDraft(false)
        }
        save({
          draft: confirmed,
          draftUpdate: undefined,
          values: nextValues,
          key: undefined,
        })
        draftUpdate.current = null
      }
    })()
    save({ draftUpdate: draftUpdate.current })
  }
  const pick = async (field: string, dropCandidate?: string) => {
    if (!draft) return null
    if (draftUpdate.current && (await draftUpdate.current)) return null
    if (!mounted.current) return null
    const params = { draftId: draft.id, field, values: form.getValues() }
    let next: OperationDraft | null
    if (__MOTRIX_TARGET__ === 'electron')
      next = await invokeOperation<OperationDraft | null>(
        Commands.PickPluginOperationFile,
        { ...params, ...(dropCandidate ? { dropCandidate } : {}) }
      )
    else {
      const options = await invokeOperation<FilePickerOptions>(
        Commands.GetPluginOperationPicker,
        params
      )
      const candidate = await platform.pickFile?.(options)
      if (!candidate) return null
      next = await invokeOperation<OperationDraft | null>(
        Commands.PickPluginOperationFile,
        { ...params, candidate }
      )
    }
    if (!next) return null
    acceptDraft(next)
    return next
  }
  const start = form.handleSubmit(async (values) => {
    if (!draft || inFlight.current || draftUpdate.current || job) return
    inFlight.current = true
    cancelRequested.current = false
    setStarting(true)
    setPending(true)
    setError('')
    let activeDraft = draft
    try {
      for (const [field, binding] of Object.entries(
        draft.descriptor.definition.files ?? {}
      )) {
        if (
          binding.kind === 'output-file' &&
          !draft.files[field] &&
          draft.suggestions?.[field]
        ) {
          const selected = await pick(field)
          if (!selected || cancelRequested.current) return
          activeDraft = selected
          values = selected.args
        }
      }
      const result = validateOperationValues(
        activeDraft.descriptor.argsSchema,
        values
      )
      if (Object.keys(result.errors).length) {
        for (const field of Object.keys(result.errors))
          form.setError(field, { message: t('pluginOperations.invalidValue') })
        return
      }
      const key =
        useOperationSessions.getState().sessions[sessionKey]?.key ??
        crypto.randomUUID()
      save({ key })
      if (cancelRequested.current) return
      let next = await invokeOperation<OperationJob>(
        Commands.StartPluginOperation,
        {
          draftId: activeDraft.id,
          descriptorRevision: activeDraft.descriptor.descriptorRevision,
          idempotencyKey: key,
          args: result.value,
        }
      )
      save({ job: next })
      if (mounted.current) setJob(next)
      // Admission can finish after the user cancels, including after unmount.
      if (cancelRequested.current)
        next = await invokeOperation<OperationJob>(
          Commands.CancelPluginOperation,
          next.id
        )
      save({ job: next })
      if (mounted.current) setJob(next)
    } catch (e) {
      if (mounted.current) report(e)
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setPending(false)
        setStarting(false)
        setCancelling(false)
      }
    }
  })
  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    if (starting && !job) {
      cancelRequested.current = true
      return
    }
    if (!job) return
    try {
      const next = await invokeOperation<OperationJob>(
        Commands.CancelPluginOperation,
        job.id
      )
      save({ job: next })
      if (mounted.current) setJob(next)
    } catch (e) {
      if (mounted.current) report(e)
    } finally {
      if (mounted.current) setCancelling(false)
    }
  }
  const descriptor =
    loadedDescriptor &&
    (!draft ||
      loadedDescriptor.descriptorRevision ===
        draft.descriptor.descriptorRevision)
      ? loadedDescriptor
      : draft?.descriptor
  if (resumingDraft || (!draft && !job && !starting && pending))
    return <OperationSkeleton />
  if (!descriptor || (!draft && !job && !starting))
    return (
      <div role="status" className="space-y-3">
        <p>{t(error || 'pluginOperations.loading')}</p>
        {!pending && (
          <Button size="sm" onClick={() => void prepare()}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    )
  const definition = descriptor.definition
  return (
    <FormProvider {...form}>
      <form
        onSubmit={start}
        className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      >
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <OperationIcon name={definition.icon} />
            {definition.title}
          </h3>
          <p className="text-sm text-muted-foreground">
            {definition.description}
          </p>
        </div>
        {draft && (
          <OperationFields
            descriptor={descriptor}
            draft={draft}
            blocked={blocked}
            pick={async (field) =>
              (await pick(field))?.files[field]?.ref ?? null
            }
            drop={async (field, path) =>
              (await pick(field, path))?.files[field]?.ref ?? null
            }
            change={change}
            onPending={setPending}
            onError={report}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t(error)}
          </p>
        )}
        {starting && !job && (
          <p role="status">{t('pluginOperations.status.preparing')}</p>
        )}
        {job && (
          <div
            className="space-y-2 rounded-xl border bg-card p-4"
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              {job.status === 'succeeded' && (
                <CheckIcon aria-hidden className="size-4" />
              )}
              <p role="status" className="flex-1 text-sm">
                {t(`pluginOperations.status.${job.status}`)}
              </p>
              {running && job.percent !== null && (
                <span className="text-xs tabular-nums">
                  {Math.round(job.percent)}%
                </span>
              )}
            </div>
            {running && (
              <Progress
                value={job.percent ?? undefined}
                aria-label={definition.title}
              />
            )}
            {job.error && job.status !== 'cancelled' && (
              <p role="alert">
                {job.error.startsWith('operation.error.')
                  ? (definition.errors?.[job.error.slice(16)] ??
                    t('pluginOperations.failed'))
                  : t(job.error)}
              </p>
            )}
            {job.cleanupWarning && (
              <p>{t('pluginOperations.cleanupWarning')}</p>
            )}
            {job.outputs.map((output) => (
              <div key={output.id} className="space-y-2">
                <p
                  dir="ltr"
                  className="break-all text-xs text-muted-foreground"
                >
                  {output.location ?? output.name}
                </p>
                {__MOTRIX_TARGET__ === 'electron' && (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={revealing}
                    onClick={() => {
                      setRevealing(true)
                      void invokeOperation(
                        Commands.RevealPluginOperation,
                        job.id
                      )
                        .catch(report)
                        .finally(() => {
                          if (mounted.current) setRevealing(false)
                        })
                    }}
                  >
                    <RevealFolderIcon aria-hidden className="me-1 size-4" />
                    {t('panel.downloads.action.openFolder')}
                  </Button>
                )}
              </div>
            ))}
            {job.result &&
              Object.entries(job.result).map(([field, value]) => (
                <p key={field}>
                  {descriptor.resultSchema.properties?.[field]?.title ?? field}:{' '}
                  {String(value)}
                </p>
              ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {definition.ui?.footer}
          </p>
          <div className="flex min-w-0 max-w-full gap-2">
            {onClose && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={onClose}
              >
                {t(job || starting ? 'common.close' : 'common.cancel')}
              </Button>
            )}
            {!job && !starting && (
              <Button
                size="sm"
                type="submit"
                disabled={
                  blocked ||
                  updatingDraft ||
                  descriptor.argsSchema.required?.some(
                    (field) =>
                      !values[field] &&
                      values[field] !== false &&
                      values[field] !== 0 &&
                      !draft?.suggestions?.[field]
                  )
                }
              >
                <span className="truncate">
                  {definition.ui?.submitLabel ?? t('pluginOperations.run')}
                </span>
              </Button>
            )}
            {(running || starting) && (
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={
                  cancelling ||
                  (!!job &&
                    ['committing', 'cleaning', 'cancelling'].includes(
                      job.status
                    ))
                }
                onClick={() => void cancel()}
              >
                {t('common.cancel')}
              </Button>
            )}
            {job && isOperationTerminal(job.status) && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void prepare(
                    definition.ui?.repeat && definition.ui.repeat !== 'reset'
                      ? job.id
                      : undefined
                  )
                }
              >
                <span className="truncate">
                  {definition.ui?.repeatLabel ?? t('pluginOperations.runAgain')}
                </span>
              </Button>
            )}
          </div>
        </div>
      </form>
    </FormProvider>
  )
}
