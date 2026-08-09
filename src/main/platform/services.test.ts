import { RunHost } from '@shared/platform/services'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths: Record<string, string> = { userData: '/fake/userData' }

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => paths[name] ?? `/fake/${name}`,
    setPath: (name: string, value: string) => {
      paths[name] = value
    },
    isPackaged: false,
  },
}))

describe('createElectronPlatformServices', () => {
  beforeEach(() => {
    vi.resetModules()
    paths.userData = '/fake/userData'
    delete process.env.MOTRIX_USER_DATA
  })

  afterEach(() => {
    delete process.env.MOTRIX_USER_DATA
  })

  it('resolves paths from Electron app API in dev', async () => {
    const { createElectronPlatformServices } = await import('./services')
    const svc = createElectronPlatformServices()
    expect(svc.host).toBe(RunHost.Electron)
    expect(svc.userDataDir).toBe('/fake/userData')
    expect(svc.isDev).toBe(true)
    expect(svc.aria2BinaryPath.endsWith('aria2c')).toBe(true)
    expect(svc.extraResourceDir).toMatch(/extra$/)
  })

  it('honors MOTRIX_USER_DATA env override', async () => {
    process.env.MOTRIX_USER_DATA = '/tmp/motrix-e2e-xyz'
    const { createElectronPlatformServices } = await import('./services')
    const svc = createElectronPlatformServices()
    expect(svc.userDataDir).toBe('/tmp/motrix-e2e-xyz')
  })
})
