import { zodResolver } from '@hookform/resolvers/zod'
import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import {
  AudioIcon,
  CheckIcon,
  FolderIcon,
  RevealFolderIcon,
  VideoIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Progress } from '@renderer/components/ui/progress'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@renderer/components/ui/toggle-group'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import {
  type MediaMergeArgs,
  type MediaMergeJob,
  type MediaMergeProvider,
  type MediaMergeStart,
  mediaMergeStartSchema,
} from '@shared/schemas/manual-media-merge'
import { useEffect, useId, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useMediaMergeSessions } from './media-merge-store'

interface Props {
  pluginId?: string
  taskIds?: string[]
  enabled?: boolean
  onClose?: () => void
  onBusyChange?: (busy: boolean) => void
}

export function MediaMergeForm({
  pluginId,
  taskIds,
  enabled = true,
  onClose,
  onBusyChange,
}: Props) {
  const id = useId()
  const sessionKey = pluginId ?? 'download-selection'
  const [initial] = useState(
    () => useMediaMergeSessions.getState().sessions[sessionKey]
  )
  const { t } = useTranslation()
  const [providers, setProviders] = useState<MediaMergeProvider[]>([])
  const [job, setJob] = useState<MediaMergeJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [error, setError] = useState('')
  const [preferredFormat, setPreferredFormat] = useState<'mp4' | 'mkv'>(
    initial?.format ?? 'mp4'
  )
  const form = useForm<MediaMergeStart>({
    resolver: zodResolver(mediaMergeStartSchema),
    defaultValues: initial?.values ?? {
      pluginId: pluginId ?? '',
      videoInput: '',
      audioInput: '',
      output: '',
    },
  })
  const running = job?.status === 'running' || job?.status === 'cancelling'
  const busy = loading || form.formState.isSubmitting || picking || running
  const selectedPlugin = form.watch('pluginId')
  const ready =
    !!form.watch('videoInput') &&
    !!form.watch('audioInput') &&
    !!form.watch('output')
  const outputPath = form.watch('output')
  const format = /\.mkv$/i.test(outputPath)
    ? 'mkv'
    : /\.mp4$/i.test(outputPath)
      ? 'mp4'
      : preferredFormat
  useEffect(() => {
    useMediaMergeSessions.getState().save(sessionKey, { format })
  }, [format, sessionKey])
  const foreignJob = !!pluginId && !!job && job.pluginId !== pluginId
  const available =
    enabled &&
    providers.some((provider) => provider.pluginId === selectedPlugin)

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])
  useEffect(() => {
    const subscription = form.watch(() => {
      useMediaMergeSessions
        .getState()
        .save(sessionKey, { values: form.getValues() })
    })
    return () => subscription.unsubscribe()
  }, [form, sessionKey])
  useEffect(() => {
    if (job && !foreignJob)
      useMediaMergeSessions.getState().save(sessionKey, { job })
  }, [job, foreignJob, sessionKey])

  useEffect(() => {
    let stale = false
    setLoading(true)
    setError('')
    setJob(null)
    const saved = useMediaMergeSessions.getState().sessions[sessionKey]
    void Promise.all([
      transport.invoke(Commands.GetMediaMergeState) as Promise<{
        providers: MediaMergeProvider[]
        job: MediaMergeJob | null
      }>,
      taskIds
        ? (transport.invoke(
            Commands.GetMediaMergeSelection,
            taskIds
          ) as Promise<MediaMergeArgs>)
        : Promise.resolve(
            saved?.values ?? { videoInput: '', audioInput: '', output: '' }
          ),
      saved?.job && !taskIds
        ? (transport
            .invoke(Commands.GetMediaMergeJob, saved.job.id)
            .catch(() => null) as Promise<MediaMergeJob | null>)
        : Promise.resolve(null),
    ])
      .then(([state, inputs, previousJob]) => {
        if (stale) return
        setProviders(enabled ? state.providers : [])
        setJob(state.job ?? previousJob)
        form.reset({
          ...inputs,
          pluginId:
            pluginId ??
            (state.providers.some(
              (provider) => provider.pluginId === saved?.values?.pluginId
            )
              ? saved?.values?.pluginId
              : state.providers[0]?.pluginId) ??
            '',
        })
      })
      .catch((cause: unknown) => {
        if (!stale)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [pluginId, taskIds, enabled, form, sessionKey])

  const jobId = job?.id
  useEffect(() => {
    if (!jobId || !running) return
    let stale = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = (await transport.invoke(
          Commands.GetMediaMergeJob,
          jobId
        )) as MediaMergeJob
        if (!stale) {
          setJob(next)
          setError('')
        }
      } catch (cause) {
        if (!stale)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!stale) timer = setTimeout(poll, 500)
      }
    }
    void poll()
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [jobId, running])

  const submit = form.handleSubmit(async (values) => {
    if (!available || busy) return
    setError('')
    try {
      const next = (await transport.invoke(
        Commands.StartMediaMerge,
        values
      )) as MediaMergeJob
      // Navigation can unmount the form before this reply. Keep the handle
      // immediately so a later visit can still retrieve the completed result.
      useMediaMergeSessions.getState().save(sessionKey, { values, job: next })
      setJob(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  })
  const cancel = async () => {
    if (!job) return
    try {
      setJob(
        (await transport.invoke(
          Commands.CancelMediaMerge,
          job.id
        )) as MediaMergeJob
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const message = error || (foreignJob ? undefined : job?.error)
  const errorKey = message?.match(/^mediaMerge\.(\w+)$/)?.[1]

  return (
    <FormProvider {...form}>
      <form onSubmit={submit} className="space-y-3">
        {!loading && !available && (
          <p role="status" className="text-sm">
            {t(!enabled ? 'mediaMerge.pluginDisabled' : 'mediaMerge.noPlugin')}
          </p>
        )}
        {!pluginId && providers.length > 1 && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-provider`}>{t('mediaMerge.provider')}</Label>
            <select
              id={`${id}-provider`}
              {...form.register('pluginId')}
              disabled={busy || !enabled}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              {providers.map((provider) => (
                <option key={provider.pluginId} value={provider.pluginId}>
                  {provider.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['videoInput', 'audioInput', 'output'] as const).map((field) => {
            const output = field === 'output'
            return (
              <div
                key={field}
                className={
                  output
                    ? 'space-y-2 sm:col-span-2 sm:mt-1'
                    : 'min-w-0 space-y-2'
                }
              >
                {output && (
                  <div className="flex items-center justify-between gap-3 px-1">
                    <span
                      id={`${id}-format-label`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t('mediaMerge.format')}
                    </span>
                    <ToggleGroup
                      aria-labelledby={`${id}-format-label`}
                      value={[format]}
                      disabled={
                        busy ||
                        !available ||
                        (job?.status === 'completed' && !foreignJob)
                      }
                      onValueChange={(values) => {
                        const next = values[0]
                        if (next !== 'mp4' && next !== 'mkv') return
                        setPreferredFormat(next)
                        setError('')
                        if (outputPath)
                          form.setValue(
                            'output',
                            `${outputPath.replace(/\.[^./\\]+$/, '')}.${next}`,
                            { shouldDirty: true, shouldValidate: true }
                          )
                      }}
                    >
                      <ToggleGroupItem type="button" value="mp4">
                        MP4
                      </ToggleGroupItem>
                      <ToggleGroupItem type="button" value="mkv">
                        MKV
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                )}
                <DirectoryPicker
                  name={field}
                  variant="file"
                  file={{
                    kind: output ? 'save' : 'open',
                    ...(output ? { extensions: [format] } : {}),
                  }}
                  allowDrop={!output}
                  onPickError={(cause) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause)
                    )
                  }
                  prefixLabel={t(`mediaMerge.${field}`)}
                  placeholder={t(`mediaMerge.choose.${field}`)}
                  fileHint={t(`mediaMerge.hint.${field}`)}
                  fileIconClassName={
                    output
                      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
                      : field === 'videoInput'
                        ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
                        : 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400'
                  }
                  fileIcon={
                    output ? (
                      <FolderIcon aria-hidden />
                    ) : field === 'videoInput' ? (
                      <VideoIcon aria-hidden />
                    ) : (
                      <AudioIcon aria-hidden />
                    )
                  }
                  inputProps={{
                    id: `${id}-${field}`,
                    'aria-invalid': !!form.formState.errors[field],
                    'aria-describedby': form.formState.errors[field]
                      ? `${id}-${field}-error`
                      : undefined,
                  }}
                  browseLabel={t('mediaMerge.browseField', {
                    field: t(`mediaMerge.${field}`),
                  })}
                  disabled={
                    busy ||
                    !available ||
                    (job?.status === 'completed' && !foreignJob)
                  }
                  onPickingChange={setPicking}
                  onPicked={(picked) => {
                    setError('')
                    if (field === 'videoInput' && !form.getValues('output'))
                      form.setValue(
                        'output',
                        `${picked.replace(/\.[^./\\]+$/, '')}-merged.${format}`,
                        { shouldDirty: true }
                      )
                  }}
                />
                {form.formState.errors[field] && (
                  <p
                    id={`${id}-${field}-error`}
                    className="text-xs text-destructive"
                  >
                    {t('mediaMerge.required')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {t(
            __MOTRIX_TARGET__ === 'web'
              ? 'mediaMerge.serverPaths'
              : 'mediaMerge.outputHint'
          )}
        </p>
        {job && !foreignJob && (
          <div
            className="space-y-3 rounded-xl border bg-card p-4"
            role="status"
          >
            <div className="flex items-center gap-2">
              {job.status === 'completed' && (
                <CheckIcon
                  aria-hidden
                  className="size-4 text-green-600 dark:text-green-400"
                />
              )}
              <p className="text-sm font-medium">
                {t(`mediaMerge.${job.status}`)}
              </p>
              {running && job.percent != null && (
                <span className="ms-auto text-xs tabular-nums text-muted-foreground">
                  {Math.round(job.percent)}%
                </span>
              )}
            </div>
            {running && (
              <Progress
                value={job.percent ?? undefined}
                aria-label={t('mediaMerge.running')}
              />
            )}
            {job.status === 'completed' && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 break-all text-xs text-muted-foreground">
                  {job.output}
                </p>
                {__MOTRIX_TARGET__ === 'electron' && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={revealing}
                    onClick={async () => {
                      setRevealing(true)
                      setError('')
                      try {
                        await transport.invoke(Commands.RevealInFolder, {
                          mediaMergeJobId: job.id,
                        })
                      } catch (cause) {
                        setError(
                          cause instanceof Error ? cause.message : String(cause)
                        )
                      } finally {
                        setRevealing(false)
                      }
                    }}
                  >
                    <RevealFolderIcon />
                    {t('panel.downloads.action.openFolder')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {foreignJob && running && (
          <p role="status" className="text-sm">
            {t('mediaMerge.busy')}
          </p>
        )}
        {message && (
          <p role="alert" className="break-words text-sm text-destructive">
            {errorKey ? t(`mediaMerge.${errorKey}`) : message}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <p className="me-auto text-xs text-muted-foreground">
            {t('mediaMerge.preserveOriginals')}
          </p>
          {running && !foreignJob ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void cancel()}
              disabled={job?.status === 'cancelling'}
            >
              {t('common.cancel')}
            </Button>
          ) : onClose ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              {t('common.close')}
            </Button>
          ) : null}
          {job?.status === 'completed' && !foreignJob ? (
            <Button
              type="button"
              size="sm"
              disabled={busy || !available}
              onClick={() => {
                setJob(null)
                setError('')
                setPreferredFormat(format)
                form.setValue('output', '', { shouldDirty: true })
                useMediaMergeSessions.getState().save(sessionKey, { job: null })
              }}
            >
              {t('mediaMerge.again')}
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={busy || !available || !ready}
            >
              {t('mediaMerge.start')}
            </Button>
          )}
        </div>
      </form>
    </FormProvider>
  )
}
