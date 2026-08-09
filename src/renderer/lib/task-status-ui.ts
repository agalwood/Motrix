import { TaskStatus } from '@shared/types/task'

export interface StatusTone {
  bg: string
  text: string
}

const TONE_MAP: Record<TaskStatus, StatusTone> = {
  [TaskStatus.Queued]: { bg: 'bg-blue-100', text: 'text-blue-800' },
  [TaskStatus.FetchingMetadata]: { bg: 'bg-blue-100', text: 'text-blue-800' },
  // MetadataReady distinguishes "Awaiting your file selection" from
  // "Still fetching": violet conveys "needs human input" without
  // looking like a download in progress.
  [TaskStatus.MetadataReady]: { bg: 'bg-violet-100', text: 'text-violet-800' },
  [TaskStatus.Downloading]: { bg: 'bg-blue-100', text: 'text-blue-800' },
  [TaskStatus.Finalizing]: { bg: 'bg-purple-100', text: 'text-purple-700' },
  [TaskStatus.Seeding]: { bg: 'bg-green-100', text: 'text-green-700' },
  [TaskStatus.Paused]: { bg: 'bg-amber-100', text: 'text-amber-700' },
  [TaskStatus.Completed]: { bg: 'bg-slate-100', text: 'text-slate-600' },
  [TaskStatus.Error]: { bg: 'bg-red-100', text: 'text-red-700' },
  [TaskStatus.Removed]: { bg: 'bg-slate-100', text: 'text-slate-500' },
}

export function getStatusTone(status: TaskStatus): StatusTone {
  return TONE_MAP[status]
}

const BAR_TONE_MAP: Record<TaskStatus, string> = {
  [TaskStatus.Queued]: 'bg-blue-500',
  [TaskStatus.FetchingMetadata]: 'bg-blue-500',
  [TaskStatus.MetadataReady]: 'bg-violet-500',
  [TaskStatus.Downloading]: 'bg-blue-500',
  [TaskStatus.Finalizing]: 'bg-purple-500',
  [TaskStatus.Seeding]: 'bg-green-500',
  [TaskStatus.Paused]: 'bg-amber-500',
  [TaskStatus.Completed]: 'bg-green-500',
  [TaskStatus.Error]: 'bg-red-500',
  [TaskStatus.Removed]: 'bg-slate-400',
}

export function getProgressBarTone(status: TaskStatus): string {
  return BAR_TONE_MAP[status]
}

/** Tailwind variant class for mirroring directional icons under RTL. */
export const rtlMirror = 'rtl:-scale-x-100'
