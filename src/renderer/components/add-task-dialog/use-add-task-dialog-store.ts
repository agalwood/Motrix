import {
  getTaskListSnapshot,
  invalidateTaskList,
} from '@renderer/hooks/use-task-list'
import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import type { ParsedTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import { create } from 'zustand'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface AddTaskDialogState {
  open: boolean
  revision: number
  torrentFiles?: ParsedTorrentFile[]
  prefill: DeepPartial<AddTaskFormValues> | undefined
  tasksAtOpen?: readonly DownloadTask[]
  openWith: (
    prefill?: DeepPartial<AddTaskFormValues>,
    torrentFiles?: ParsedTorrentFile[]
  ) => void
  close: () => void
}

export const useAddTaskDialogStore = create<AddTaskDialogState>((set, get) => ({
  open: false,
  revision: 0,
  prefill: undefined,
  openWith: (prefill, torrentFiles) => {
    if (get().open) return
    const isSelection = prefill?.tab === 'torrent' && prefill.existingTaskId
    set((state) => ({
      open: true,
      prefill,
      torrentFiles,
      revision: state.revision + 1,
      tasksAtOpen: isSelection ? getTaskListSnapshot().tasks : undefined,
    }))
    // A selection response/event proves metadata is ready. Only a snapshot
    // obtained after it may settle this picker, including after a retry.
    if (isSelection) invalidateTaskList()
  },
  close: () =>
    set((state) => ({
      open: false,
      prefill: undefined,
      torrentFiles: undefined,
      tasksAtOpen: undefined,
      revision: state.revision + 1,
    })),
}))

onOperatorSessionLost(() => useAddTaskDialogStore.getState().close())
