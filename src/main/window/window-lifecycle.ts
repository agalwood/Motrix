import type { WindowId } from '@shared/types/window'
import type { BrowserWindow } from 'electron'

export type WindowLifecycleReason =
  | 'user-dismiss'
  | 'retention'
  | 'recovery'
  | 'configuration'
  | 'shutdown'

export interface WindowLifecycle {
  created(id: WindowId, win: BrowserWindow, show: boolean): void
  released(id: WindowId, reason: WindowLifecycleReason): void
  dismissed(id: WindowId): void
  shown(id: WindowId): void
  loadFailed(id: WindowId, win: BrowserWindow): void
}
