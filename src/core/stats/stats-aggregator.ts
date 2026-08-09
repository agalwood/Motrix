import type { GlobalStats } from '@shared/types/stats'

export class StatsAggregator {
  private currentStats: GlobalStats = {
    totalDownloadSpeed: 0,
    totalUploadSpeed: 0,
    activeTasks: 0,
    waitingTasks: 0,
    stoppedTasks: 0,
  }

  getStats(): GlobalStats {
    return { ...this.currentStats }
  }

  update(stats: GlobalStats): void {
    this.currentStats = stats
  }
}
