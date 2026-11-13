import type { DownloadProxyOptions } from '@core/proxy/serializers'
import type { EngineSettings } from '@shared/types/settings'

/** Taiji's supported settings contract. Wire names and units live only here. */
const runtimeFields = {
  maxConcurrentDownloads: 'max-concurrent-downloads',
  maxConnectionPerServer: 'max-connection-per-server',
  split: 'split',
  minSplitSize: 'min-split-size',
  userAgent: 'user-agent',
  connectTimeout: 'connect-timeout',
  socketTimeout: 'timeout',
  maxTries: 'max-tries',
  retryWait: 'retry-wait',
  btMaxPeers: 'bt-max-peers',
  btEnableLpd: 'bt-lsd',
  seedRatio: 'seed-ratio',
  remoteTime: 'remote-time',
} as const satisfies Partial<Record<keyof EngineSettings, string>>

export function taijiRuntimeSettings(
  settings: EngineSettings,
  previous?: EngineSettings
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(runtimeFields).flatMap(([key, wire]) => {
      const setting = key as keyof typeof runtimeFields
      return !previous || settings[setting] !== previous[setting]
        ? [[wire, String(settings[setting])]]
        : []
    })
  )
}

export function taijiProxyOptions(
  proxy: DownloadProxyOptions | null
): Record<string, string> {
  return {
    'all-proxy': proxy?.allProxy ?? '',
    'no-proxy': proxy?.noProxy ?? '',
    'http-proxy': '',
    'https-proxy': '',
    'ftp-proxy': '',
  }
}
