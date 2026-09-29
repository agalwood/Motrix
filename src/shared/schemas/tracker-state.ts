import { z } from 'zod'

export const TRACKER_SOURCE_MAX_AGE_MS = 7 * 86_400_000
export const TRACKER_HEALTH_MAX_AGE_MS = 7 * 86_400_000
export const TRACKER_PROBE_FRESH_MS = 12 * 3_600_000
export const TRACKER_HISTORY_MAX_AGE_MS = 30 * 86_400_000
export const TRACKER_MAX_CANDIDATES = 10_000
export const TRACKER_MAX_SOURCE_URLS = 5_000
export const TRACKER_MAX_SOURCE_BYTES = 2 * 1024 * 1024

const time = z.number().finite().nonnegative()
export const trackerSampleSchema = z.object({
  at: time,
  ok: z.boolean(),
})
export const trackerHealthSchema = z.object({
  url: z.string(),
  protocol: z.enum(['http', 'https', 'udp', 'ws', 'wss']),
  status: z.enum(['healthy', 'slow', 'unreachable', 'unknown']),
  lastProbeMs: z.number().nonnegative().nullable(),
  lastProbeAt: time.nullable(),
  successCount: z.number().nonnegative(),
  failCount: z.number().nonnegative(),
  successRate: z.number().min(0).max(1),
  samples: z.array(trackerSampleSchema).max(20).optional(),
  routeKey: z.string().optional(),
  evidence: z.enum(['http', 'udp', 'none']).optional(),
})
export const trackerSourceSnapshotSchema = z.object({
  id: z.string(),
  url: z.string(),
  kind: z.enum(['tracker', 'blacklist']),
  urls: z.array(z.string()).max(TRACKER_MAX_SOURCE_URLS),
  lastAttemptAt: time.nullable(),
  lastSuccessAt: time.nullable(),
  contentChangedAt: time.nullable(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  error: z
    .enum(['network', 'http', 'invalid', 'limit', 'missing-cache'])
    .nullable(),
  failures: z.number().int().nonnegative(),
  nextRetryAt: time.nullable(),
})
export const trackerCandidateSchema = z.object({
  url: z.string(),
  sourceIds: z.array(z.string()),
  firstSeenAt: time,
  reason: z.enum([
    'selected',
    'capacity',
    'blacklisted',
    'unsupported',
    'cooldown',
  ]),
})
export const trackerSyncRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['manual', 'scheduled', 'retry']),
  startedAt: time,
  finishedAt: time,
  outcome: z.enum(['success', 'partial', 'failed']),
  successfulSources: z.number().int().nonnegative(),
  failedSources: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
})
export const trackerStateSchema = z.object({
  version: z.literal(2).optional(),
  effective: z.array(z.string()).default([]),
  blacklist: z.array(z.string()).default([]),
  healthMap: z.record(z.string(), trackerHealthSchema).default({}),
  sourceMap: z.record(z.string(), z.array(z.string())).default({}),
  lastSyncAt: time.nullable().default(null),
  lastProbeAt: time.nullable().default(null),
  snapshots: z.record(z.string(), trackerSourceSnapshotSchema).default({}),
  candidates: z.array(trackerCandidateSchema).default([]),
  firstSeen: z.record(z.string(), time).default({}),
  history: z.array(trackerSyncRunSchema).max(100).default([]),
  lastAttemptAt: time.nullable().default(null),
  nextCheckAt: time.nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  pendingEngineApply: z.boolean().default(false),
})
export type TrackerSourceSnapshot = z.infer<typeof trackerSourceSnapshotSchema>
export type TrackerCandidate = z.infer<typeof trackerCandidateSchema>
export type TrackerSyncRun = z.infer<typeof trackerSyncRunSchema>
export type TrackerState = z.infer<typeof trackerStateSchema>

export type TrackerHealth = z.infer<typeof trackerHealthSchema>
