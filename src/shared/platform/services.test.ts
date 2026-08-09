import { describe, expect, it } from 'vitest'
import type { PlatformServices } from './services'
import { RunHost } from './services'

describe('PlatformServices', () => {
  it('exposes the hosts we target', () => {
    expect(RunHost.Electron).toBe('electron')
    expect(RunHost.Node).toBe('node')
  })

  it('typechecks a concrete implementation', () => {
    const fake: PlatformServices = {
      host: RunHost.Node,
      userDataDir: '/data',
      extraResourceDir: '/extra',
      aria2BinaryPath: '/usr/bin/aria2c',
      isDev: false,
    }
    expect(fake.host).toBe('node')
  })
})
