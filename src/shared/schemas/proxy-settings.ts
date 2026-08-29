import type { ProxySettings } from '@shared/types/settings'
import { z } from 'zod'

const withoutControlCharacters = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasC0OrDel(value))

function hasC0OrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export const proxySettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  protocol: z.enum(['http', 'https', 'socks5']).catch('http'),
  host: withoutControlCharacters(253).catch(''),
  port: z.number().int().min(1).max(65535).catch(8080),
  user: withoutControlCharacters(256).catch(''),
  password: withoutControlCharacters(256).catch(''),
  bypass: z.array(withoutControlCharacters(253)).max(64).catch([]),
  scopes: z
    .object({
      download: z.boolean().catch(false),
      updateApp: z.boolean().catch(false),
      updateTrackers: z.boolean().catch(false),
    })
    .catch({ download: false, updateApp: false, updateTrackers: false }),
})

export const DEFAULT_PROXY_SETTINGS: ProxySettings = proxySettingsSchema.parse(
  {}
)
