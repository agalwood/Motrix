import type { SettingsManager } from '@core/settings/settings-manager'
import { DEFAULT_NAT_SETTINGS } from '@core/settings/validators'
import { describe, expect, it, vi } from 'vitest'
import { SettingsNatProvider } from './settings-nat-provider'

describe('SettingsNatProvider', () => {
  it('projects engine settings to the NatManager shape', () => {
    const settings = {
      getEngine: vi.fn(
        () =>
          ({
            listenPort: 6881,
            dhtListenPort: 6882,
            rpcPort: 16800,
            // ... other fields ignored
          }) as unknown
      ),
      get: vi.fn(
        () =>
          ({
            nat: { ...DEFAULT_NAT_SETTINGS, enabled: true },
          }) as unknown
      ),
    } as unknown as SettingsManager

    const p = new SettingsNatProvider(settings)
    expect(p.getEngine()).toEqual({ listenPort: 6881, dhtListenPort: 6882 })
  })

  it('projects nat settings', () => {
    const settings = {
      getEngine: vi.fn(
        () => ({ listenPort: 6881, dhtListenPort: 6881 }) as unknown
      ),
      get: vi.fn(
        () =>
          ({
            nat: { ...DEFAULT_NAT_SETTINGS, enabled: false },
          }) as unknown
      ),
    } as unknown as SettingsManager
    const p = new SettingsNatProvider(settings)
    expect(p.getNat().enabled).toBe(false)
  })
})
