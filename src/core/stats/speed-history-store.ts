// src/core/stats/speed-history-store.ts
import type { GlobalStats, SpeedPoint } from '@shared/types/stats'

export const SPEED_HISTORY_MAX_POINTS = 200

export class SpeedHistoryStore {
  private buffer: SpeedPoint[] = []

  append(stats: GlobalStats): void {
    this.buffer.push({
      t: Date.now(),
      down: stats.totalDownloadSpeed,
      up: stats.totalUploadSpeed,
    })
    if (this.buffer.length > SPEED_HISTORY_MAX_POINTS) {
      this.buffer.splice(0, this.buffer.length - SPEED_HISTORY_MAX_POINTS)
    }
  }

  snapshot(limit = SPEED_HISTORY_MAX_POINTS): readonly SpeedPoint[] {
    if (limit >= this.buffer.length) return [...this.buffer]
    return this.buffer.slice(-limit)
  }

  clear(): void {
    this.buffer = []
  }
}
