import type { TaskInspectorActivitySnapshot } from '@shared/types/task-inspector-activity'

export function makeTaskInspectorActivitySnapshot(
  taskId = 'task-1',
  revision = 1
): TaskInspectorActivitySnapshot {
  const updatedAt = Math.max(1, revision)
  return {
    taskId,
    revision,
    summary: {
      trackingStartedAt: 1,
      coverageGapAt: null,
      revision,
      lastEventOrdinal: 0,
      activeMs: 0,
      downloadActiveMs: 0,
      estimatedDownloadBytes: '0',
      estimatedUploadBytes: '0',
      peakDownloadBps: 0,
      peakUploadBps: 0,
      rawSampleCount: 0,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
      updatedAt,
    },
    timeline: {
      events: [],
      trackingStartedAt: 1,
      coverageGapAt: null,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
    },
    lifetime: {
      points: [],
      averageDownloadSpeed: 0,
      peakDownloadSpeed: 0,
      peakUploadSpeed: 0,
      activeMs: 0,
      updatedAt,
      accuracy: 'estimated',
    },
  }
}
