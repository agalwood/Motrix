import type { SettingsManager } from '@core/settings/settings-manager'
import type { NatSettingsProvider } from '@motrix/nat'

export class SettingsNatProvider implements NatSettingsProvider {
  constructor(private settings: SettingsManager) {}

  getEngine() {
    const e = this.settings.getEngine()
    return {
      listenPort: e.listenPort,
      // The taiji listener multiplexes DHT and uTP on the BT port.
      // A migrated legacy DHT port must not map a socket that is unused.
      dhtListenPort: e.listenPort,
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
