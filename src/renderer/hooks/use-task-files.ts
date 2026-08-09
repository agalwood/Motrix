import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { TaskFile } from '@shared/types/task'
import { useCallback, useEffect, useState } from 'react'

interface TaskFilesUpdatedPayload {
  taskId: string
}

export function useTaskFiles(taskId: string) {
  const [files, setFiles] = useState<TaskFile[]>([])
  const [loading, setLoading] = useState(true)

  const fetchFiles = useCallback(async () => {
    setLoading(true)
    try {
      const result = (await transport.invoke(
        Queries.GetTaskFiles,
        taskId
      )) as TaskFile[]
      setFiles(result)
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void fetchFiles()
    const onUpdated = (...args: unknown[]) => {
      const payload = args[0] as TaskFilesUpdatedPayload | undefined
      if (payload?.taskId === taskId) void fetchFiles()
    }
    transport.on(Events.TaskFilesUpdated, onUpdated)
    return () => {
      transport.off(Events.TaskFilesUpdated, onUpdated)
    }
  }, [taskId, fetchFiles])

  return { files, loading, refetch: fetchFiles }
}
