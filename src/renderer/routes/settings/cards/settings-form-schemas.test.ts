import { i18n } from '@renderer/lib/i18n'
import { settingsValidationError } from '@renderer/lib/settings-validation'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_MEDIA_SETTINGS,
  DEFAULT_NAT_SETTINGS,
  DEFAULT_PROXY_SETTINGS,
  DEFAULT_TRACKER_SETTINGS,
} from '@shared/schemas'
import {
  DEFAULT_GEOIP_SETTINGS,
  geoIpSettingsInputSchema,
} from '@shared/schemas/geoip-settings'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  advancedFormSchema,
  appearanceFormSchema,
  bitTorrentFormSchema,
  generalFormSchema,
  integrationFormSchema,
  networkFormSchema,
} from './settings-form-schemas'

const forms: Record<string, { schema: z.ZodType; values: object }> = {
  general: {
    schema: generalFormSchema,
    values: { ...DEFAULT_APP_SETTINGS, defaultSaveDir: '/Downloads' },
  },
  appearance: { schema: appearanceFormSchema, values: DEFAULT_APP_SETTINGS },
  advanced: { schema: advancedFormSchema, values: DEFAULT_ENGINE_SETTINGS },
  network: {
    schema: networkFormSchema,
    values: {
      proxy: DEFAULT_PROXY_SETTINGS,
      nat: DEFAULT_NAT_SETTINGS,
      engine: DEFAULT_ENGINE_SETTINGS,
    },
  },
  bittorrent: {
    schema: bitTorrentFormSchema,
    values: {
      engine: DEFAULT_ENGINE_SETTINGS,
      app: DEFAULT_APP_SETTINGS,
      tracker: DEFAULT_TRACKER_SETTINGS,
    },
  },
  integration: {
    schema: integrationFormSchema,
    values: { app: DEFAULT_APP_SETTINGS, media: DEFAULT_MEDIA_SETTINGS },
  },
  geoip: { schema: geoIpSettingsInputSchema, values: DEFAULT_GEOIP_SETTINGS },
}

function withField(values: object, path: string, value: unknown) {
  const result = structuredClone(values) as Record<string, unknown>
  const keys = path.split('.')
  let target = result
  for (const key of keys.slice(0, -1))
    target = target[key] as Record<string, unknown>
  target[keys[keys.length - 1]] = value
  return result
}

describe('Settings form schemas', () => {
  it.each(Object.entries(forms))(
    '%s accepts hydrated defaults',
    (_, { schema, values }) => {
      expect(schema.safeParse(values).success).toBe(true)
    }
  )

  it.each([
    ['general', 'defaultSaveDir', '  '],
    ['general', 'notifyOnComplete', 'yes'],
    ['appearance', 'theme', 'unknown'],
    ['appearance', 'runMode', 999],
    ['advanced', 'rpcPort', 65536],
    ['advanced', 'rpcPort', NaN],
    ['advanced', 'rpcPort', 1234.5],
    ['advanced', 'rpcSecret', 'secret\nline'],
    ['advanced', 'sqlite3DbPath', '/tmp/\0file'],
    ['advanced', 'sqlite3HistoryLimit', 1000001],
    ['network', 'proxy.port', 1e100],
    ['network', 'proxy.scopes.download', 'yes'],
    ['network', 'proxy.bypass', ['a'.repeat(254)]],
    ['network', 'nat.mappingTtl', 1199],
    ['network', 'nat.diagnosticIntervalSec', 86401],
    ['network', 'nat.stunServers', ['stun.example.com:65536']],
    ['network', 'nat.portCheckerEndpoints', ['http://example.com']],
    ['network', 'nat.portCheckerEndpoints', ['https:example.com']],
    ['bittorrent', 'engine.btMaxPeers', 1e100],
    ['bittorrent', 'engine.seedRatio', -1],
    ['bittorrent', 'app.magnetFileSelectionTimeoutSeconds', 9],
    ['bittorrent', 'tracker.syncIntervalHours', 169],
    ['bittorrent', 'tracker.maxTrackerCount', 201],
    ['bittorrent', 'tracker.probeTimeoutMs', 999],
    ['bittorrent', 'tracker.minSuccessRate', 1.1],
    ['integration', 'app.protocols.magnet', 'yes'],
    ['integration', 'media.ffmpegStagingMB', 65537],
    ['integration', 'media.ffmpegOpTimeoutSec', 3601],
    ['integration', 'media.ffmpegBinaryPath', '/tmp/\0ffmpeg'],
    ['geoip', 'customUrl', 'x'.repeat(2049)],
  ])('%s rejects invalid %s without falling back', (name, path, value) => {
    const { schema, values } = forms[name as string]
    const result = schema.safeParse(withField(values, path as string, value))
    expect(result.success).toBe(false)
    if (result.success) return
    expect(
      result.error.issues.some((issue) =>
        issue.path.join('.').startsWith(path as string)
      )
    ).toBe(true)
  })

  it.each(['', 'http://localhost', 'localhost:8080', '[::1]:80', 'host/path'])(
    'requires a proxy host without scheme or port: %s',
    (host) => {
      const values = {
        ...forms.network.values,
        proxy: { ...DEFAULT_PROXY_SETTINGS, enabled: true, host },
      }
      expect(networkFormSchema.safeParse(values).success).toBe(false)
    }
  )

  it.each(['localhost', '127.0.0.1', 'proxy.example.com', '::1', '[::1]'])(
    'accepts proxy server %s',
    (host) => {
      const values = {
        ...forms.network.values,
        proxy: { ...DEFAULT_PROXY_SETTINGS, enabled: true, host },
      }
      expect(networkFormSchema.safeParse(values).success).toBe(true)
    }
  )

  it('requires a valid custom GeoIP URL only when that source is enabled', () => {
    const values = {
      ...DEFAULT_GEOIP_SETTINGS,
      enabled: true,
      source: 'custom',
      customUrl: 'example.com',
    }
    expect(geoIpSettingsInputSchema.safeParse(values).success).toBe(false)
    expect(
      geoIpSettingsInputSchema.safeParse({
        ...values,
        customUrl: 'https://example.com/country.mmdb',
      }).success
    ).toBe(true)
    expect(
      geoIpSettingsInputSchema.safeParse({ ...values, enabled: false }).success
    ).toBe(true)
  })

  it.each([
    ['en-US', 'Enter a whole number from 1024 to 65535.'],
    ['zh-CN', '请输入 1024–65535 之间的整数。'],
    ['zh-TW', '請輸入 1024–65535 之間的整數。'],
  ])('explains numeric bounds in %s', (locale, message) => {
    const result = advancedFormSchema.safeParse(
      { ...DEFAULT_ENGINE_SETTINGS, rpcPort: 1e100 },
      {
        error: settingsValidationError(
          i18n.getFixedT(locale),
          advancedFormSchema
        ),
      }
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toBe(message)
  })
})
