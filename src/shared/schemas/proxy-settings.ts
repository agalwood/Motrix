import type { ProxySettings } from '@shared/types/settings'
import { z } from 'zod'
import { settingsInputObject } from './settings-input'

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

function isProxyHost(host: string): boolean {
  if (
    !host ||
    /[\s\\/?#@]/.test(host) ||
    (host.startsWith('[') && !host.endsWith(']'))
  )
    return false
  try {
    const authority =
      host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const url = new URL(`http://${authority}`)
    return url.hostname.length > 0 && !url.port && url.pathname === '/'
  } catch {
    return false
  }
}

export const proxySettingsInputSchema = settingsInputObject(proxySettingsSchema)
  .extend({
    scopes: settingsInputObject(proxySettingsSchema.shape.scopes.removeCatch()),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !isProxyHost(value.host)) {
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        params: { settingIssue: 'proxyHost' },
      })
    }
  })
