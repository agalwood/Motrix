import type { PluginNetworkFailure } from '@shared/schemas/plugin-network'
import type { TFunction } from 'i18next'

export function formatPluginNetworkFailure(
  t: TFunction,
  failure: PluginNetworkFailure
): string {
  const reason = t(`plugins.network.${failure.reason}`, {
    status: failure.status ?? '',
  })
  if (!failure.route) return reason
  return t(
    failure.route === 'proxy'
      ? 'plugins.network.viaProxy'
      : 'plugins.network.direct',
    {
      host: failure.targetHost,
      proxy: failure.proxyEndpoint ?? '',
      reason,
    }
  )
}
