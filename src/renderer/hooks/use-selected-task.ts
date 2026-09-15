import { useDownloadsSelection } from '@renderer/routes/downloads/store'
import type { DownloadTask } from '@shared/types/task'
import { useMemo } from 'react'

export interface SelectedTaskSnapshot {
  task: DownloadTask | null
  atTop: boolean
  atBottom: boolean
}

export function useSelectedTask(): SelectedTaskSnapshot {
  const signature = useDownloadsSelection((state) => {
    const task = state.items.find((task) =>
      state.committedSelectedIds.has(task.id)
    )
    return JSON.stringify([task?.id, task?.status])
  })
  return useMemo(() => {
    const [id] = JSON.parse(signature)
    const task =
      useDownloadsSelection.getState().items.find((task) => task.id === id) ??
      null
    return { task, atTop: false, atBottom: false }
  }, [signature])
}
