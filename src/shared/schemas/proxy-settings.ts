import type { ProxySettings } from '@shared/types/settings'
import { z } from 'zod'

export const proxySettingsSchema = z
  .object({
    enabled: z.boolean().catch(false),
    protocol: z.enum(['http', 'https', 'socks5']).catch('http'),
    host: z.string().max(253).catch(''),
    port: z.number().int().min(1).max(65535).catch(8080),
    user: z.string().max(256).catch(''),
    password: z.string().max(256).catch(''),
    bypass: z.array(z.string().max(253)).max(64).catch([]),
    scopes: z
      .object({
        download: z.boolean().catch(false),
        updateApp: z.boolean().catch(false),
        updateTrackers: z.boolean().catch(false),
      })
      .catch({ download: false, updateApp: false, updateTrackers: false }),
  })
  .transform((settings) =>
    settings.protocol === 'socks5' && settings.scopes.download
      ? {
          ...settings,
          scopes: { ...settings.scopes, download: false },
        }
      : settings
  )

export const DEFAULT_PROXY_SETTINGS: ProxySettings = proxySettingsSchema.parse(
  {}
)
