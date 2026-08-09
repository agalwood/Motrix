import type {
  SpeedLimitSettings,
  SpeedTestProvider,
} from '@shared/types/settings'
import { z } from 'zod'

const profileSchema = z.object({
  download: z.number().min(0).catch(0),
  upload: z.number().min(0).catch(0),
})

const scheduleSchema = z.object({
  enabled: z.boolean().catch(false),
  from: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .catch('23:00'),
  to: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .catch('07:00'),
  days: z.array(z.number().int().min(0).max(6)).catch([]),
})

const videoAppSchema = z.object({
  enabled: z.boolean().catch(false),
  processNames: z.array(z.string()).catch([]),
})

const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  download: z
    .object({ url: z.string(), sizeParam: z.string().optional() })
    .nullable(),
  upload: z.object({ url: z.string() }).nullable(),
})

const SPEED_TEST_PRESETS: SpeedTestProvider[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    download: {
      url: 'https://speed.cloudflare.com/__down',
      sizeParam: 'bytes',
    },
    upload: { url: 'https://speed.cloudflare.com/__up' },
  },
  {
    id: 'apple',
    label: 'Apple',
    download: { url: 'https://mensura.cdn-apple.com/api/v1/gm/large' },
    upload: null,
  },
]

const speedTestSchema = z.object({
  providers: z.array(providerSchema).catch(SPEED_TEST_PRESETS),
  selectedProviderId: z.string().catch('cloudflare'),
  concurrency: z.number().int().min(1).max(16).catch(4),
  maxDurationSec: z.number().int().min(1).max(60).catch(10),
  maxDataMB: z.number().int().min(1).max(10240).catch(1024),
})

const adaptiveSchema = z.object({
  enabled: z.boolean().catch(false),
  linkDown: z.number().min(0).catch(0),
  linkUp: z.number().min(0).catch(0),
  headroomPercent: z.number().int().min(1).max(100).catch(80),
  speedTest: speedTestSchema.catch(speedTestSchema.parse({})),
})

const autoSchema = z.object({
  schedule: scheduleSchema.catch(scheduleSchema.parse({})),
  videoApp: videoAppSchema.catch(videoAppSchema.parse({})),
  adaptive: adaptiveSchema.catch(adaptiveSchema.parse({})),
})

export const speedLimitSettingsSchema = z.object({
  base: profileSchema.catch({ download: 0, upload: 0 }),
  alt: profileSchema.catch({ download: 512 * 1024, upload: 64 * 1024 }),
  turtle: z.enum(['off', 'on', 'auto']).catch('off'),
  auto: autoSchema.catch(autoSchema.parse({})),
})

export const DEFAULT_SPEED_LIMIT_SETTINGS: SpeedLimitSettings =
  speedLimitSettingsSchema.parse({})
