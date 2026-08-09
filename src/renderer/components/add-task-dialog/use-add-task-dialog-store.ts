import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { create } from 'zustand'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface AddTaskDialogState {
  open: boolean
  prefill: DeepPartial<AddTaskFormValues> | undefined
  openWith: (prefill?: DeepPartial<AddTaskFormValues>) => void
  close: () => void
}

export const useAddTaskDialogStore = create<AddTaskDialogState>((set) => ({
  open: false,
  prefill: undefined,
  openWith: (prefill) => set({ open: true, prefill }),
  close: () => set({ open: false, prefill: undefined }),
}))
