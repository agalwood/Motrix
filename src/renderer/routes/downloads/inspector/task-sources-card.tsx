import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { taskWritesAvailable } from '@renderer/features/application-menu/task-context'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type TaskSourcesSnapshot,
  taskSourcesSnapshotSchema,
  taskSourceUrlsSchema,
} from '@shared/schemas/task-sources'
import { type DownloadTask, TaskKind } from '@shared/types/task'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function TaskSourcesCard({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  useOperatorSession()
  const canWrite = transport.platform !== 'web' || taskWritesAvailable()
  const [snapshot, setSnapshot] = useState<TaskSourcesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState<string[]>([])
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const mounted = useRef(true)
  const title = t(
    snapshot?.kind === 'webseed' || task.kind === TaskKind.Bt
      ? 'task.sources.webSeeds'
      : 'task.sources.title'
  )
  const message = (reason: unknown) => {
    const text = reason instanceof Error ? reason.message : String(reason)
    return (
      ['changed', 'invalid', 'unavailable'].find((key) =>
        text.includes(`task.sources.${key}`)
      ) ?? 'failed'
    )
  }
  const load = useCallback(
    async (resetDraft = false) => {
      const current = ++sequence.current
      setLoading(true)
      try {
        const value = taskSourcesSnapshotSchema.parse(
          await transport.invoke(Queries.GetTaskSources, {
            taskId: task.id,
            engineTaskId: task.engineTaskId,
          })
        )
        if (mounted.current && current === sequence.current) {
          setSnapshot(value)
          if (resetDraft) {
            setDraft(value.uris.join('\n'))
            setBaseline(value.uris)
          }
          setError('')
        }
      } catch {
        if (mounted.current && current === sequence.current) setError('failed')
      } finally {
        if (mounted.current && current === sequence.current) setLoading(false)
      }
    },
    [task.id, task.engineTaskId]
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: Task state changes alter the engine editing permissions.
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      void load()
    }
    transport.on(Events.EngineStateChanged, refresh)
    void load()
    return () => {
      mounted.current = false
      sequence.current++
      transport.off(Events.EngineStateChanged, refresh)
    }
  }, [load, task.status])

  async function apply() {
    if (!snapshot?.editable || busy || !canWrite) return
    const uris = draft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const parsed = taskSourceUrlsSchema(snapshot.kind).safeParse(uris)
    if (!parsed.success) {
      setError('invalid')
      return
    }
    setBusy(true)
    setError('')
    try {
      const value = taskSourcesSnapshotSchema.parse(
        await transport.invoke(Commands.SetTaskSources, {
          taskId: task.id,
          engineTaskId: task.engineTaskId,
          previous: baseline,
          uris: parsed.data,
        })
      )
      if (mounted.current) {
        sequence.current++
        setSnapshot(value)
        setLoading(false)
        setOpen(false)
      }
    } catch (reason) {
      if (mounted.current) setError(message(reason))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const occurrences = new Map<string, number>()
  const rows = snapshot?.uris.map((uri) => {
    const occurrence = (occurrences.get(uri) ?? 0) + 1
    occurrences.set(uri, occurrence)
    return { uri, key: JSON.stringify([uri, occurrence]) }
  })
  return (
    <section className="rounded-md bg-muted/60 p-3" aria-label={title}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        <div className="flex gap-1">
          {error && (
            <Button
              size="xs"
              variant="ghost"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              {t('common.retry')}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || busy || !snapshot?.editable || !canWrite}
            onClick={() => {
              setDraft(snapshot?.uris.join('\n') ?? '')
              setBaseline(snapshot?.uris ?? [])
              setError('')
              setOpen(true)
            }}
          >
            {t('task.sources.edit')}
          </Button>
        </div>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <ul className="space-y-1 break-all text-xs select-text" dir="ltr">
          {rows?.map(({ uri, key }) => (
            <li key={key}>{uri}</li>
          ))}
          {!snapshot?.uris.length && (
            <li className="text-muted-foreground">—</li>
          )}
        </ul>
      )}
      {error && !open && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t(`task.sources.${error}`)}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent forceRenderOverlay>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t(
                snapshot?.kind === 'webseed'
                  ? 'task.sources.webseedDescription'
                  : 'task.sources.description'
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={title}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={7}
            dir="ltr"
            spellCheck={false}
            disabled={busy || loading}
          />
          {error && (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="text-xs text-destructive">
                {t(`task.sources.${error}`)}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || loading}
                onClick={() => void load(true)}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy || loading || !canWrite || !snapshot?.editable}
              onClick={() => void apply()}
            >
              {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
