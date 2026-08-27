import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { TaskFile } from '@shared/types/task'
import { useCallback, useEffect, useRef, useState } from 'react'

interface TaskFilesUpdatedPayload {
  taskId: string
}

export function useTaskFiles(taskId: string, live = false) {
  const [files, setFiles] = useState<TaskFile[]>([])
  const [loading, setLoading] = useState(true)
  const requestGeneration = useRef(0)

  const fetchFiles = useCallback(
    async (showLoading = true) => {
      const request = ++requestGeneration.current
      if (showLoading) setLoading(true)
      try {
        const result = (await transport.invoke(
          Queries.GetTaskFiles,
          taskId
        )) as TaskFile[]
        if (request !== requestGeneration.current) return
        setFiles(result)
      } finally {
        if (request === requestGeneration.current) {
          setLoading(false)
        }
      }
    },
    [taskId]
  )

  useEffect(() => {
    const onUpdated = (...args: unknown[]) => {
      const payload = args[0] as TaskFilesUpdatedPayload | undefined
      if (payload?.taskId === taskId) void fetchFiles(false)
    }
    const onTaskUpdated = (...args: unknown[]) => {
      const payload = args[0]
      if (
        !Array.isArray(payload) ||
        payload.some(
          (task) =>
            typeof task === 'object' &&
            task !== null &&
            'id' in task &&
            task.id === taskId
        )
      ) {
        void fetchFiles(false)
      }
    }
    transport.on(Events.TaskFilesUpdated, onUpdated)
    if (live) transport.on(Events.TaskUpdated, onTaskUpdated)
    void fetchFiles()
    return () => {
      transport.off(Events.TaskFilesUpdated, onUpdated)
      if (live) transport.off(Events.TaskUpdated, onTaskUpdated)
      requestGeneration.current += 1
    }
  }, [taskId, live, fetchFiles])

  return { files, loading, refetch: () => fetchFiles(true) }
}
