import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { TaskFile } from '@shared/types/task'
import { useCallback, useEffect, useRef, useState } from 'react'

const REFRESH_INTERVAL_MS = 2_000

function filesEqual(a: TaskFile[], b: TaskFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, index) => {
      const other = b[index]
      return (
        file.index === other.index &&
        file.path === other.path &&
        file.size === other.size &&
        file.completedBytes === other.completedBytes &&
        file.selected === other.selected &&
        file.progress === other.progress
      )
    })
  )
}

/** Mount only for a visible file panel; null disables all requests. */
export function useTaskFiles(
  taskId: string | null,
  live = false,
  engineTaskId?: string
) {
  const [files, setFiles] = useState<TaskFile[]>([])
  const [loading, setLoading] = useState(taskId !== null)
  const [visible, setVisible] = useState(() => !document.hidden)
  const refresh = useRef<(() => Promise<void>) | null>(null)
  const lastIdentity = useRef({ taskId, engineTaskId })
  const refetch = useCallback(
    () => refresh.current?.() ?? Promise.resolve(),
    []
  )

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    // A GID swap keeps the public task id but invalidates its file responses.
    // Clear old identity even while the document is hidden.
    if (
      lastIdentity.current.taskId !== taskId ||
      lastIdentity.current.engineTaskId !== engineTaskId
    ) {
      lastIdentity.current = { taskId, engineTaskId }
      setFiles([])
    }
    if (taskId === null || !visible) {
      setLoading(false)
      return
    }
    let disposed = false
    let inFlight: Promise<void> | null = null
    let queued = false
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = (): Promise<void> => {
      clearTimeout(timer)
      if (disposed) return Promise.resolve()
      if (inFlight) {
        queued = true
        revision += 1
        return inFlight
      }
      const startedAtRevision = revision
      const request = (async () => {
        try {
          const result = (await transport.invoke(
            Queries.GetTaskFiles,
            taskId
          )) as TaskFile[]
          if (disposed || startedAtRevision !== revision) return
          setFiles((previous) =>
            filesEqual(previous, result) ? previous : result
          )
        } catch {
          // Keep last-known data. Live panels retry on their own cadence;
          // paused panels can retry on reconnect or an explicit invalidation.
        } finally {
          if (!disposed) setLoading(false)
        }
      })()
      inFlight = request
      void request.finally(() => {
        inFlight = null
        if (disposed) return
        if (queued) {
          queued = false
          void load()
        } else if (live) {
          timer = setTimeout(() => void load(), REFRESH_INTERVAL_MS)
        }
      })
      return request
    }
    const onUpdated = (...args: unknown[]) => {
      const payload = args[0] as { taskId?: string } | undefined
      if (payload?.taskId === taskId) void load()
    }
    const detachConnection = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') void load()
    })
    transport.on(Events.TaskFilesUpdated, onUpdated)
    refresh.current = load
    setLoading(true)
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
      detachConnection?.()
      transport.off(Events.TaskFilesUpdated, onUpdated)
      if (refresh.current === load) refresh.current = null
    }
  }, [taskId, live, visible, engineTaskId])

  return { files, loading, refetch }
}
