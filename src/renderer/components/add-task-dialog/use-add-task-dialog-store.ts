import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { create } from 'zustand'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface AddTaskDialogState {
  open: boolean
  revision: number
  prefill: DeepPartial<AddTaskFormValues> | undefined
  openWith: (prefill?: DeepPartial<AddTaskFormValues>) => void
  close: () => void
}

export const useAddTaskDialogStore = create<AddTaskDialogState>((set) => ({
  open: false,
  revision: 0,
  prefill: undefined,
  openWith: (prefill) =>
    set((state) => ({ open: true, prefill, revision: state.revision + 1 })),
  close: () =>
    set((state) => ({
      open: false,
      prefill: undefined,
      revision: state.revision + 1,
    })),
}))
