import { RunHost } from '@shared/platform/services'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalResourcesPath = Object.getOwnPropertyDescriptor(
  process,
  'resourcesPath'
)

const mocks = vi.hoisted(() => {
  const state = {
    isPackaged: false,
    paths: { userData: '/fake/Motrix' } as Record<string, string>,
    operations: [] as string[],
  }

  return {
    state,
    mkdirSync: vi.fn((directory: string) => {
      state.operations.push(`mkdir:${directory}`)
    }),
    getPath: vi.fn((name: string) => state.paths[name] ?? `/fake/${name}`),
    setPath: vi.fn((name: string, value: string) => {
      state.operations.push(`setPath:${name}:${value}`)
      state.paths[name] = value
    }),
  }
})

vi.mock('node:fs', () => ({
  default: { mkdirSync: mocks.mkdirSync },
  mkdirSync: mocks.mkdirSync,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.state.isPackaged
    },
    getPath: mocks.getPath,
    setPath: mocks.setPath,
  },
}))

import { createElectronPlatformServices } from './services'

describe('createElectronPlatformServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.isPackaged = false
    mocks.state.paths = { userData: '/fake/Motrix' }
    mocks.state.operations = []
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/fake/resources',
    })
    delete process.env.MOTRIX_USER_DATA
  })

  afterEach(() => {
    delete process.env.MOTRIX_USER_DATA
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
  })

  it('uses a sibling development profile by default', () => {
    const svc = createElectronPlatformServices()

    expect(svc.host).toBe(RunHost.Electron)
    expect(svc.userDataDir).toBe('/fake/Motrix-dev')
    expect(svc.isDev).toBe(true)
    expect(svc.aria2BinaryPath.endsWith('aria2c')).toBe(true)
    expect(svc.extraResourceDir).toMatch(/extra$/)
  })

  it('gives MOTRIX_USER_DATA priority in development', () => {
    process.env.MOTRIX_USER_DATA = '/tmp/motrix-custom'

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/tmp/motrix-custom')
  })

  it('ignores an empty MOTRIX_USER_DATA value', () => {
    process.env.MOTRIX_USER_DATA = ''

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/fake/Motrix-dev')
  })

  it('keeps the Electron user data directory unchanged when packaged', () => {
    mocks.state.isPackaged = true

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/fake/Motrix')
    expect(svc.isDev).toBe(false)
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
  })

  it('honors MOTRIX_USER_DATA when packaged', () => {
    mocks.state.isPackaged = true
    process.env.MOTRIX_USER_DATA = '/tmp/motrix-packaged'

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/tmp/motrix-packaged')
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/tmp/motrix-packaged', {
      recursive: true,
    })
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      1,
      'userData',
      '/tmp/motrix-packaged'
    )
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      2,
      'sessionData',
      '/tmp/motrix-packaged'
    )
  })

  it('rejects a relative MOTRIX_USER_DATA before creating it', () => {
    process.env.MOTRIX_USER_DATA = 'relative/profile'

    expect(() => createElectronPlatformServices()).toThrow(
      'MOTRIX_USER_DATA must be an absolute path'
    )
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
  })

  it('creates the selected directory before setting both Electron paths', () => {
    createElectronPlatformServices()

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/fake/Motrix-dev', {
      recursive: true,
    })
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      1,
      'userData',
      '/fake/Motrix-dev'
    )
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      2,
      'sessionData',
      '/fake/Motrix-dev'
    )
    expect(mocks.state.operations).toEqual([
      'mkdir:/fake/Motrix-dev',
      'setPath:userData:/fake/Motrix-dev',
      'setPath:sessionData:/fake/Motrix-dev',
    ])
  })
})
