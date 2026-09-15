import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
import type { ParsedTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { create } from 'zustand'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface AddTaskDialogState {
  open: boolean
  revision: number
  torrentFiles?: ParsedTorrentFile[]
  prefill: DeepPartial<AddTaskFormValues> | undefined
  openWith: (
    prefill?: DeepPartial<AddTaskFormValues>,
    torrentFiles?: ParsedTorrentFile[]
  ) => void
  close: () => void
}

export const useAddTaskDialogStore = create<AddTaskDialogState>((set) => ({
  open: false,
  revision: 0,
  prefill: undefined,
  openWith: (prefill, torrentFiles) =>
    set((state) =>
      state.open
        ? state
        : { open: true, prefill, torrentFiles, revision: state.revision + 1 }
    ),
  close: () =>
    set((state) => ({
      open: false,
      prefill: undefined,
      torrentFiles: undefined,
      revision: state.revision + 1,
    })),
}))

onOperatorSessionLost(() => useAddTaskDialogStore.getState().close())
