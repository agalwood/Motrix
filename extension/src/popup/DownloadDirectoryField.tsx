import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DownloadDirectoryConnectionContext } from '@/popup/DownloadDirectoryConnection'
import { supportsBackendConnections } from '@/shared/browserKind'
import type { DownloadDirectoriesResponse } from '@/shared/downloadDirectories'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import type { TaskOptions } from '@/shared/taskOptions'

export function DownloadDirectoryField({
  value,
  onChange,
  disabled,
}: {
  value: TaskOptions
  onChange: (value: TaskOptions) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const connectionKey = useContext(DownloadDirectoryConnectionContext)
  const [response, setResponse] = useState<DownloadDirectoriesResponse | null>(
    null
  )
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const requestId = useRef(0)
  const connectionPending = useRef(false)
  const refresh = useCallback(async (connect = false) => {
    const request = ++requestId.current
    setResponse(null)
    setConnecting(connect)
    setConnectionError(null)
    connectionPending.current = connect
    try {
      if (connect) {
        // Reuse the bounded connection flow for the active backend. It can
        // wake a paired local App, without submitting a task or starting pairing.
        await send('bg.viewTasks', undefined)
        if (requestId.current !== request) return
      }
      const result = await send('bg.getDownloadDirectories', undefined)
      if (requestId.current === request)
        setResponse(result ?? { status: 'unavailable' })
    } catch (error) {
      if (requestId.current !== request) return
      setResponse({ status: 'unavailable' })
      if (connect)
        setConnectionError(
          error instanceof Error &&
            error.message === DOWNLOAD_ERROR.pairingRequired
            ? 'popup.integration.pairingRequired'
            : 'errors.connection.generic'
        )
    } finally {
      connectionPending.current = false
      if (requestId.current === request) setConnecting(false)
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Connection changes invalidate the directory snapshot.
  useEffect(() => {
    // An explicit connection already queries the final authenticated backend.
    // Intermediate poll states must not cancel it or re-enable the button.
    if (!connectionPending.current) void refresh()
  }, [refresh, connectionKey])
  useEffect(
    () => () => {
      requestId.current += 1
    },
    []
  )
  const ready = response?.status === 'ready' ? response : null
  const selected = value.directory
  const seen = new Set<string>()
  const groups = ready
    ? (
        [
          [
            'directoryDefault',
            ready.directories.defaultSaveDir
              ? [ready.directories.defaultSaveDir]
              : [],
          ],
          ['directoryFavorites', ready.directories.favorites],
          ['directoryRecent', ready.directories.recent],
        ] as const
      ).map(([key, paths]) => ({
        key,
        paths: paths.filter((path) => {
          if (seen.has(path)) return false
          seen.add(path)
          return true
        }),
      }))
    : []
  const invalid =
    !!selected &&
    !!response &&
    (!ready ||
      selected.endpointId !== ready.binding.endpointId ||
      selected.endpointRevision !== ready.binding.endpointRevision ||
      selected.instanceId !== ready.binding.instanceId ||
      !seen.has(selected.path))
  const hint = invalid
    ? 'directoryUnavailable'
    : !response
      ? 'directoryLoading'
      : response.status === 'unsupported'
        ? 'directoryUnsupported'
        : response.status === 'unavailable'
          ? 'directoryOffline'
          : 'directoryHint'
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <label className="min-w-0 text-xs font-medium" htmlFor={id}>
          {t('popup.taskForm.directory')}
        </label>
        <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-0.5 text-xs"
            disabled={
              disabled ||
              !response ||
              response.status !== 'unavailable' ||
              !supportsBackendConnections()
            }
            aria-busy={connecting}
            onClick={() => void refresh(true)}
          >
            {t(connecting ? 'popup.status.connecting' : 'popup.reconnect')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-0.5 text-xs"
            disabled={disabled || !response}
            onClick={() => void refresh()}
          >
            {t('popup.taskForm.directoryRefresh')}
          </Button>
        </div>
      </div>
      <Select
        value={
          selected && (!ready || invalid)
            ? null
            : (selected?.path ?? '__default__')
        }
        disabled={disabled}
        onValueChange={(path) => {
          const { directory: _directory, ...rest } = value
          if (path === '__default__') onChange(rest)
          else if (path && ready && seen.has(path))
            onChange({ ...rest, directory: { ...ready.binding, path } })
        }}
      >
        <SelectTrigger
          id={id}
          aria-describedby={`${id}-hint`}
          aria-invalid={invalid}
          className="w-full min-w-0"
        >
          <SelectValue className="min-w-0 truncate">
            {selected ? (
              <span dir="ltr" className="truncate" title={selected.path}>
                {selected.path}
              </span>
            ) : (
              t('popup.taskForm.directoryAutomatic')
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value="__default__">
            {t('popup.taskForm.directoryAutomatic')}
          </SelectItem>
          {groups
            .filter((group) => group.paths.length > 0)
            .map((group) => (
              <SelectGroup key={group.key}>
                <SelectLabel>{t(`popup.taskForm.${group.key}`)}</SelectLabel>
                {group.paths.map((path) => (
                  <SelectItem key={path} value={path} className="min-w-0">
                    <span dir="ltr" className="truncate" title={path}>
                      {path}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
        </SelectContent>
      </Select>
      <p
        id={`${id}-hint`}
        role={connectionError ? 'alert' : undefined}
        className={
          invalid || connectionError
            ? 'text-xs/5 text-destructive'
            : 'text-xs/5 text-muted-foreground'
        }
      >
        {t(
          connectionError ??
            (connecting ? 'popup.status.connecting' : `popup.taskForm.${hint}`)
        )}
      </p>
    </div>
  )
}
