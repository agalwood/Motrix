import type {
  OperationDescriptor,
  OperationDraft,
  OperationJob,
} from '@shared/schemas/plugin-operations'
import { create } from 'zustand'
export interface OperationRequest {
  pluginId: string
  operationId: string
  taskIds?: string[]
}
export const useOperationDialog = create<{
  request: OperationRequest | null
  openWith(request: OperationRequest): void
  close(): void
}>((set) => ({
  request: null,
  openWith: (request) => set({ request }),
  close: () => set({ request: null }),
}))
export interface OperationSession {
  descriptor?: OperationDescriptor
  draft?: OperationDraft
  values?: Record<string, string | number | boolean>
  job?: OperationJob
  key?: string
}
export const useOperationSessions = create<{
  sessions: Record<string, OperationSession>
  save(key: string, patch: OperationSession): void
  replace(key: string, session: OperationSession): void
}>((set) => ({
  sessions: {},
  replace: (key, session) =>
    set((state) => ({ sessions: { ...state.sessions, [key]: session } })),
  save: (key, patch) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...state.sessions[key], ...patch },
      },
    })),
}))
export const operationSessionKey = (request: OperationRequest) =>
  JSON.stringify([request.pluginId, request.operationId, request.taskIds ?? []])
