// src/core/stats/index.ts

export {
  SPEED_HISTORY_MAX_POINTS,
  SpeedHistoryStore,
} from './speed-history-store'
export { StatsAggregator } from './stats-aggregator'
export {
  TASK_SPEED_HISTORY_MAX_POINTS,
  TaskSpeedHistoryStore,
} from './task-speed-history-store'
export { TransferStatsRuntime } from './transfer-stats-runtime'
export type {
  TransferCheckpointState,
  TransferStatsServiceOptions,
} from './transfer-stats-service'
export {
  MAX_TRANSFER_SAMPLE_GAP_SECONDS,
  MAX_WALL_MONOTONIC_DRIFT_MS,
  TRANSFER_CHECKPOINT_MS,
  TRANSFER_PRUNE_INTERVAL_MS,
  TransferStatsService,
} from './transfer-stats-service'
export type {
  PersistedTransferBucket,
  PersistedTransferTotals,
  TransferDelta,
} from './transfer-stats-store'
export {
  TRANSFER_BUCKET_MS,
  TRANSFER_RETENTION_MS,
  TransferStatsStore,
} from './transfer-stats-store'
