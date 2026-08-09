import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { useTaskBtDetail } from '@renderer/hooks/use-task-bt-detail'
import { useTaskBtTracker } from '@renderer/hooks/use-task-bt-tracker'
import { useTrackerList } from '@renderer/hooks/use-tracker-list'
import { parseTrackerInput } from '@renderer/lib/trackers'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { Lock, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface TrackerRowData {
  url: string
  deletable: boolean
}

interface TrackersTabProps {
  task: DownloadTask
}

const ROW_HEIGHT = 24

/** Longer than the 1 Hz authoritative poll, so a retry observes its result. */
const EMPTY_BASELINE_RETRY_DELAY_MS = 1_500
const EMPTY_BASELINE_RETRY_LIMIT = 2

export function TrackersTab({ task }: TrackersTabProps) {
  const { t } = useTranslation()
  const { effective, isLoading, error, refresh } = useTaskBtTracker(
    task.engineTaskId
  )
  const { list } = useTrackerList()

  // announceList is projected out of the broadcast (option E); read the
  // static seed list on demand from the full per-task detail. Keyed on
  // engineTaskId too: re-add / magnet swap keep the public id but replace
  // the engine generation, which is when the seed list materializes.
  const detail = useTaskBtDetail(task.id, task.engineTaskId)
  const { announceList } = detail
  const detailReady = !detail.isLoading && detail.error === null
  const announceFlat = useMemo(() => announceList.flat(), [announceList])
  const announceSet = useMemo(() => new Set(announceFlat), [announceFlat])
  const effectiveSet = useMemo(() => new Set(effective), [effective])
  const isPrivate = task.bt?.isPrivate === true
  // Tasks that aria2 no longer holds (Completed-and-evicted, Error,
  // Removed) cannot accept SetTaskBtTracker / SyncTaskBtTracker —
  // aria2.changeOption raises "GID not found". Hide Edit/Sync and the
  // drift indicator entirely so we don't offer actions that 100% fail.
  const isEditable =
    task.status !== TaskStatus.Completed &&
    task.status !== TaskStatus.Error &&
    task.status !== TaskStatus.Removed

  const rows = useMemo<TrackerRowData[]>(() => {
    const seen = new Set<string>()
    const out: TrackerRowData[] = []
    for (const url of announceFlat) {
      if (seen.has(url)) continue
      seen.add(url)
      out.push({ url, deletable: false })
    }
    for (const url of effective) {
      if (announceSet.has(url) || seen.has(url)) continue
      seen.add(url)
      // While the announce baseline is loading or failed, an "effective
      // only" classification is unreliable — a private torrent's native
      // trackers must never be presented as removable extras.
      out.push({ url, deletable: detailReady })
    }
    return out
  }, [announceFlat, announceSet, effective, detailReady])

  const driftCount = useMemo(() => {
    if (isPrivate) return 0
    if (!isEditable) return 0
    return list.effective.filter((u) => !effectiveSet.has(u)).length
  }, [list.effective, effectiveSet, isPrivate, isEditable])

  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The task/generation the edit-session state currently belongs to. The
  // component does not remount on task switch, so async continuations
  // (save/sync/delete captured across an await) must verify this key before
  // touching mode/isSaving/toasts — otherwise task A's deferred save closes
  // the editor the user just opened on task B.
  const taskKeyRef = useRef(`${task.id}:${task.engineTaskId}`)

  useEffect(() => {
    // engineTaskId is part of the key: re-add and the magnet→BT swap keep
    // the public id but replace the engine generation, and a draft seeded
    // from the old generation's effective list must not be committed
    // against the new gid.
    taskKeyRef.current = `${task.id}:${task.engineTaskId}`
    setMode('read')
    setIsSaving(false)
    setIsSyncing(false)
  }, [task.id, task.engineTaskId])

  // If a task transitions out of editable state mid-edit (e.g. polling
  // observes Seeding→Completed while the textarea is open), drop back
  // to read mode so the now-hidden Save button can't be reached.
  useEffect(() => {
    if (!isEditable) setMode('read')
  }, [isEditable])

  // First-second gap: a just-created BT task has an empty announceList
  // until the FIRST authoritative poll (~1s) copies it into TaskManager,
  // so an immediate re-query would land before that poll and cache the
  // pre-poll emptiness. Retry an empty baseline on a delay longer than the
  // poll cadence with a bounded budget per engine generation — after which
  // an empty baseline is accepted as legitimate (DHT-only torrents have
  // none). The retry deliberately does NOT require a non-empty effective
  // list (a private torrent's bt-tracker extras are legitimately empty)
  // and also covers a transiently failed detail query (detail.error).
  const emptyRetryRef = useRef({ key: '', attempts: 0 })
  useEffect(() => {
    if (detail.isLoading) return
    if (announceList.length > 0) return
    const key = `${task.id}:${task.engineTaskId}`
    if (emptyRetryRef.current.key !== key) {
      emptyRetryRef.current = { key, attempts: 0 }
    }
    if (emptyRetryRef.current.attempts >= EMPTY_BASELINE_RETRY_LIMIT) return
    // Self-driving chain: a refresh that returns the same empty result
    // leaves every dependency unchanged, so this effect would NOT re-run
    // to arm the next attempt. Each fire schedules its successor; a
    // non-empty result re-renders with a changed announceList.length,
    // which re-runs the effect and disposes the chain via cleanup.
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      timer = setTimeout(async () => {
        emptyRetryRef.current.attempts += 1
        await detail.refresh()
        if (disposed) return
        if (emptyRetryRef.current.attempts < EMPTY_BASELINE_RETRY_LIMIT) {
          arm()
        }
      }, EMPTY_BASELINE_RETRY_DELAY_MS)
    }
    arm()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [
    detail.isLoading,
    announceList.length,
    task.id,
    task.engineTaskId,
    detail.refresh,
  ])

  const editableEffective = useMemo(
    () => effective.filter((u) => !announceSet.has(u)),
    [effective, announceSet]
  )

  const startEdit = () => {
    setDraft(editableEffective.join('\n'))
    setMode('edit')
  }

  const cancelEdit = () => setMode('read')

  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length &&
    new Set(a).size === b.length &&
    a.every((x) => b.includes(x))

  const save = async () => {
    const { valid, dropped } = parseTrackerInput(draft)
    if (dropped > 0) {
      toast.add({
        title: t('panel.downloads.inspector.trackers.invalidLines', {
          count: dropped,
        }),
        type: 'warning',
      })
    }
    if (sameSet(valid, editableEffective)) {
      setMode('read')
      return
    }
    const taskKey = taskKeyRef.current
    setIsSaving(true)
    try {
      await transport.invoke(Commands.SetTaskBtTracker, {
        engineGid: task.engineTaskId,
        trackers: valid,
      })
      await refresh()
      if (taskKeyRef.current !== taskKey) return
      setMode('read')
    } catch (e) {
      if (taskKeyRef.current !== taskKey) return
      toast.add({
        title: t('panel.downloads.inspector.trackers.saveFailed', {
          reason: e instanceof Error ? e.message : String(e),
        }),
        type: 'error',
      })
      // stay in edit mode
    } finally {
      if (taskKeyRef.current === taskKey) setIsSaving(false)
    }
  }

  const sync = async () => {
    if (isPrivate) return // defensive — button is also disabled
    const taskKey = taskKeyRef.current
    setIsSyncing(true)
    try {
      await transport.invoke(Commands.SyncTaskBtTracker, {
        engineGid: task.engineTaskId,
      })
      await refresh()
    } catch (e) {
      if (taskKeyRef.current !== taskKey) return
      toast.add({
        title: t('panel.downloads.inspector.trackers.syncFailed', {
          reason: e instanceof Error ? e.message : String(e),
        }),
        type: 'error',
      })
    } finally {
      if (taskKeyRef.current === taskKey) setIsSyncing(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleDelete = async (url: string) => {
    const taskKey = taskKeyRef.current
    const next = effective.filter((u) => u !== url)
    try {
      await transport.invoke(Commands.SetTaskBtTracker, {
        engineGid: task.engineTaskId,
        trackers: next,
      })
      await refresh()
    } catch (e) {
      if (taskKeyRef.current !== taskKey) return
      toast.add({
        title: t('panel.downloads.inspector.trackers.deleteFailed', {
          reason: e instanceof Error ? e.message : String(e),
        }),
        type: 'error',
      })
    }
  }

  if (!task.bt) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {isPrivate && (
        <Alert className="shrink-0 flex items-center gap-2">
          <Lock className="size-3.5 shrink-0" />
          <span className="text-xs">
            {t('panel.downloads.inspector.trackers.privateBanner')}
          </span>
        </Alert>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t('panel.downloads.inspector.trackers.summary', {
            count: rows.length,
          })}
          {driftCount > 0 && (
            <>
              {' · '}
              <span className="text-foreground">
                {t('panel.downloads.inspector.trackers.driftSuffix', {
                  count: driftCount,
                })}
              </span>
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {mode === 'read' ? (
            isEditable ? (
              <>
                <Button size="xs" variant="outline" onClick={startEdit}>
                  {t('panel.downloads.inspector.trackers.action.edit')}
                </Button>
                <Button
                  size="xs"
                  variant={driftCount > 0 ? 'default' : 'outline'}
                  onClick={sync}
                  disabled={isPrivate || isSyncing}
                  title={
                    isPrivate
                      ? t(
                          'panel.downloads.inspector.trackers.syncPrivateDisabled'
                        )
                      : undefined
                  }
                >
                  {t('panel.downloads.inspector.trackers.action.sync')}
                </Button>
              </>
            ) : null
          ) : (
            <>
              <Button size="xs" variant="ghost" onClick={cancelEdit}>
                {t('panel.downloads.inspector.trackers.action.cancel')}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={save}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Spinner />
                ) : (
                  t('panel.downloads.inspector.trackers.action.save')
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="shrink-0">
          {t('panel.downloads.inspector.trackers.loadFailed', {
            reason: error.message,
          })}
        </Alert>
      )}

      {mode === 'edit' ? (
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border p-[2px] pb-0 bg-muted/30">
          <Textarea
            ref={textareaRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(
              'panel.downloads.inspector.trackers.editPlaceholder'
            )}
            className="min-h-[120px] max-h-[164px] flex-1 resize-none md:text-xs shadow-none leading-6 bg-background"
          />
          <p className="p-2 shrink-0 text-xs text-muted-foreground">
            {t('panel.downloads.inspector.trackers.editHint')}
          </p>
        </div>
      ) : !isLoading && rows.length === 0 ? (
        <div className="flex min-h-[120px] flex-1 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          {t('panel.downloads.inspector.trackers.empty')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border">
          <VirtualList<TrackerRowData>
            items={rows}
            getId={(r) => r.url}
            rowHeight={ROW_HEIGHT}
            className="max-h-[198px] py-2"
            renderRow={({ item }) => (
              <TrackerRow row={item} onDelete={handleDelete} t={t} />
            )}
          />
        </div>
      )}
    </div>
  )
}

interface TrackerRowProps {
  row: TrackerRowData
  onDelete: (url: string) => void | Promise<void>
  t: (key: string) => string
}

function TrackerRow({ row, onDelete, t }: TrackerRowProps) {
  return (
    <div
      data-row=""
      className={cn(
        'group grid grid-cols-[minmax(0,1fr)_24px] h-6 items-center gap-2 px-3 text-xs',
        'border-b border-border/40 last:border-b-0'
      )}
    >
      <span className="truncate text-foreground" title={row.url}>
        {row.url}
      </span>
      {row.deletable ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('panel.downloads.inspector.trackers.action.delete')}
          className="opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={() => onDelete(row.url)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : (
        <span className="size-6 shrink-0" aria-hidden="true" />
      )}
    </div>
  )
}
