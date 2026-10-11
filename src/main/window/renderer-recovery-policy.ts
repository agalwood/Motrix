import type { WindowId } from '@shared/types/window'

export const RENDERER_RECOVERY_TIMING = {
  boot: 30_000,
  probeInterval: 15_000,
  probeDeadline: 5_000,
  suspect: 30_000,
  wakeGrace: 30_000,
  modalGrace: 5_000,
  schedulerLag: 5_000,
  stable: 60_000,
  manualDebounce: 10_000,
  budgetWindow: 10 * 60_000,
  memoryBackoff: 10_000,
} as const

export type RendererExitDecision = 'recover' | 'memory' | 'block'

export function classifyRendererExit(reason: string): RendererExitDecision {
  switch (reason) {
    case 'clean-exit':
    case 'abnormal-exit':
    case 'killed':
    case 'crashed':
      return 'recover'
    case 'oom':
    case 'memory-eviction':
      return 'memory'
    default:
      return 'block'
  }
}

interface Attempt {
  at: number
  windows: readonly WindowId[]
  memory: boolean
}

/** Application-owned history survives document and BrowserWindow replacement. */
export class RendererRecoveryBudget {
  private attempts: Attempt[] = []
  private manual = new Map<WindowId, number>()

  constructor(private readonly now: () => number) {}

  reserveAutomatic(
    windows: readonly WindowId[],
    memory = false
  ): { delay: number; attempt: number } | null {
    const now = this.now()
    this.attempts = this.attempts.filter(
      (entry) => now - entry.at < RENDERER_RECOVERY_TIMING.budgetWindow
    )
    const unique = [...new Set(windows)]
    if (unique.length === 0 || this.attempts.length >= 4) return null
    let previous = 0
    for (const id of unique) {
      const history = this.attempts.filter((entry) =>
        entry.windows.includes(id)
      )
      if (history.length >= 2 || (memory && history.some((x) => x.memory))) {
        return null
      }
      previous = Math.max(previous, history.length)
    }
    this.attempts.push({ at: now, windows: unique, memory })
    return {
      delay: memory
        ? RENDERER_RECOVERY_TIMING.memoryBackoff
        : previous === 0
          ? 1_000
          : 5_000,
      attempt: previous + 1,
    }
  }

  reserveManual(id: WindowId): boolean {
    const now = this.now()
    const previous = this.manual.get(id)
    if (
      previous !== undefined &&
      now - previous < RENDERER_RECOVERY_TIMING.manualDebounce
    ) {
      return false
    }
    this.manual.set(id, now)
    return true
  }
}
