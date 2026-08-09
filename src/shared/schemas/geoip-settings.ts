import type { GeoIPSettings } from '@shared/types/geoip'
import { z } from 'zod'

export const geoIpSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  source: z
    .enum(['loyalsoldier', 'p3terx', 'maxmind', 'custom'])
    .catch('loyalsoldier'),
  customUrl: z.string().max(2048).catch(''),
  maxmindLicenseKey: z.string().max(256).catch(''),
  autoUpdate: z.boolean().catch(true),
  autoUpdateIntervalDays: z.number().int().min(1).max(365).catch(7),
  lastUpdatedAt: z.number().int().min(0).catch(0),
  databaseVersion: z.string().max(128).catch(''),
})

export const DEFAULT_GEOIP_SETTINGS: GeoIPSettings = geoIpSettingsSchema.parse(
  {}
)
