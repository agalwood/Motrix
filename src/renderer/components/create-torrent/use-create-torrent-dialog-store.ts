import { create } from 'zustand'

interface CreateTorrentDialogState {
  open: boolean
  openDialog: () => void
  close: () => void
}

export const useCreateTorrentDialogStore = create<CreateTorrentDialogState>(
  (set) => ({
    open: false,
    openDialog: () => set({ open: true }),
    close: () => set({ open: false }),
  })
)

export function openCreateTorrentDialog(): void {
  useCreateTorrentDialogStore.getState().openDialog()
}
