import type { DownloadErrorReason } from '@/shared/integration'
import type { TakeoverTarget } from '@/shared/takeover'
import type { TaskOptions } from '@/shared/taskOptions'

export const CONFIRMATION_PORT = 'motrix.download.confirmation'
export const CONFIRMATION_TIMEOUT_MS = 120_000

export interface DownloadConfirmation {
  id: string
  windowId: number
  expiresAt: number
  target: TakeoverTarget
  options: TaskOptions
  phase: 'editing' | 'submitting' | 'failed' | 'unknown'
  error?: DownloadErrorReason
}

export type ConfirmationDecision =
  | { action: 'submit'; options: TaskOptions }
  | { action: 'edit'; options: TaskOptions }
  | { action: 'browser' }
  | { action: 'cancel' }
