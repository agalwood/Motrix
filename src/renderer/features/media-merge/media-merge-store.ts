import type {
  MediaMergeJob,
  MediaMergeStart,
} from '@shared/schemas/manual-media-merge'
import { create } from 'zustand'

interface MediaMergeDialogState {
  open: boolean
  request: { pluginId?: string; taskIds?: string[] }
  openWith(request?: MediaMergeDialogState['request']): void
  close(): void
}

export const useMediaMergeDialog = create<MediaMergeDialogState>((set) => ({
  open: false,
  request: {},
  openWith: (request = {}) => set({ open: true, request }),
  close: () => set({ open: false }),
}))

interface Session {
  format?: 'mp4' | 'mkv'
  values?: MediaMergeStart
  job?: MediaMergeJob | null
}

/** Drafts are local to this renderer; job status is refreshed from the host. */
export const useMediaMergeSessions = create<{
  sessions: Record<string, Session>
  save(key: string, patch: Session): void
}>((set) => ({
  sessions: {},
  save: (key, patch) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...state.sessions[key], ...patch },
      },
    })),
}))
