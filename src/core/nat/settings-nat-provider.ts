import type { SettingsManager } from '@core/settings/settings-manager'
import type { NatSettingsProvider } from '@motrix/nat'

export class SettingsNatProvider implements NatSettingsProvider {
  constructor(private settings: SettingsManager) {}

  getEngine() {
    const e = this.settings.getEngine()
    return {
      listenPort: e.listenPort,
      dhtListenPort: e.dhtListenPort,
    }
  }

  getNat() {
    const all = this.settings.get()
    const nat = all.nat
    return {
      enabled: nat.enabled,
      preferredProtocol: nat.preferredProtocol,
      mappingTtl: nat.mappingTtl,
      natTypeDetectionEnabled: nat.natTypeDetectionEnabled,
      stunServers: [...nat.stunServers],
      portReachabilityCheckEnabled: nat.portReachabilityCheckEnabled,
      portCheckerEndpoints: [...nat.portCheckerEndpoints],
    }
  }
}
