import type { TrackerSettings } from '@shared/types/settings'
import type { TrackerSource } from '@shared/types/tracker'
import { z } from 'zod'
import { settingsInputObject } from './settings-input'

const SYNC_INTERVAL_MIN = 1
const SYNC_INTERVAL_MAX = 168
const TRACKER_COUNT_MIN = 5
const TRACKER_COUNT_MAX = 200
const syncIntervalHoursSchema = z
  .number()
  .int()
  .min(SYNC_INTERVAL_MIN)
  .max(SYNC_INTERVAL_MAX)
const maxTrackerCountSchema = z
  .number()
  .int()
  .min(TRACKER_COUNT_MIN)
  .max(TRACKER_COUNT_MAX)

// Moved from src/core/settings/validators.ts so the renderer
// (react-hook-form resolver) and the core (IPC validation)
// share a single source of truth for tracker settings.

export const ANIME_TRACKER_DIRECT_SOURCE = {
  id: 'anime-best',
  label: 'DeSireFire/animeTrackerList (best)',
  url: 'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_best.txt',
  builtin: true,
  enabled: false,
  cdn: false,
} satisfies TrackerSource

export const ANIME_TRACKER_SOURCE = {
  id: 'anime-best-cdn',
  label: 'DeSireFire/animeTrackerList (best, CDN)',
  url: 'https://cdn.jsdelivr.net/gh/DeSireFire/animeTrackerList/AT_best.txt',
  builtin: true,
  enabled: false,
  cdn: true,
} satisfies TrackerSource

export const ANIME_TRACKER_BLACKLIST_SOURCE = {
  id: 'anime-bad',
  label: 'DeSireFire/animeTrackerList (bad)',
  url: 'https://cdn.jsdelivr.net/gh/DeSireFire/animeTrackerList/AT_bad.txt',
  builtin: true,
  enabled: true,
  cdn: true,
} satisfies TrackerSource

const BUILTIN_SOURCES = [
  {
    id: 'ngosang-best',
    label: 'ngosang/trackerslist (best)',
    url: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
    builtin: true,
    enabled: true,
    cdn: false,
  },
  {
    id: 'ngosang-best-cdn',
    label: 'ngosang/trackerslist (best, CDN)',
    url: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt',
    builtin: true,
    enabled: false,
    cdn: true,
  },
  {
    id: 'xiu2-best',
    label: 'XIU2/TrackersListCollection (best)',
    url: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt',
    builtin: true,
    enabled: true,
    cdn: false,
  },
  {
    id: 'xiu2-best-cdn',
    label: 'XIU2/TrackersListCollection (best, CDN)',
    url: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/best.txt',
    builtin: true,
    enabled: false,
    cdn: true,
  },
  ANIME_TRACKER_DIRECT_SOURCE,
  ANIME_TRACKER_SOURCE,
]

const BUILTIN_BLACKLIST_SOURCES = [
  {
    id: 'xiu2-blacklist',
    label: 'XIU2/TrackersListCollection (blacklist)',
    url: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/blacklist.txt',
    builtin: true,
    enabled: true,
    cdn: true,
  },
  ANIME_TRACKER_BLACKLIST_SOURCE,
]

const trackerSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.url(),
  builtin: z.boolean().catch(false),
  enabled: z.boolean().catch(true),
  cdn: z.boolean().catch(false),
})

export const trackerSettingsSchema = z.object({
  autoSync: z.boolean().catch(true),
  syncIntervalHours: z
    .number()
    .int()
    .catch(12)
    .transform((v) =>
      Math.min(Math.max(v, SYNC_INTERVAL_MIN), SYNC_INTERVAL_MAX)
    ),
  sourcesEnabled: z.boolean().catch(true),
  sources: z.array(trackerSourceSchema).catch(BUILTIN_SOURCES),
  probeEnabled: z.boolean().catch(true),
  probeTimeoutMs: z.number().int().min(1000).max(30000).catch(5000),
  healthyThresholdMs: z.number().int().min(500).max(10000).catch(3000),
  minSuccessRate: z.number().min(0).max(1).catch(0.5),
  maxTrackerCount: z
    .number()
    .int()
    .catch(50)
    .transform((v) =>
      Math.min(Math.max(v, TRACKER_COUNT_MIN), TRACKER_COUNT_MAX)
    ),
  blacklistEnabled: z.boolean().catch(true),
  blacklistSources: z
    .array(trackerSourceSchema)
    .catch(BUILTIN_BLACKLIST_SOURCES),
})

export const DEFAULT_TRACKER_SETTINGS: TrackerSettings =
  trackerSettingsSchema.parse({})

export const trackerSettingsInputSchema = settingsInputObject(
  trackerSettingsSchema.omit({
    syncIntervalHours: true,
    maxTrackerCount: true,
  })
).extend({
  syncIntervalHours: syncIntervalHoursSchema,
  maxTrackerCount: maxTrackerCountSchema,
})

export function validateTrackerSettings(
  input: TrackerSettings
): TrackerSettings {
  return trackerSettingsSchema.parse(input)
}
