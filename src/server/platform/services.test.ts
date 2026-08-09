import path from 'node:path'
import { RunHost } from '@shared/platform/services'
import { describe, expect, it } from 'vitest'
import { createNodePlatformServices } from './services'

const FAKE_MODULE_URL = 'file:///fake/repo/dist/server/index.mjs'

describe('createNodePlatformServices', () => {
  it('linux falls back to /var/lib/motrix /usr/share/motrix/extra /usr/bin/aria2c', () => {
    const svc = createNodePlatformServices({
      platform: 'linux',
      env: {},
      homedir: () => '/home/test',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.host).toBe(RunHost.Node)
    expect(svc.userDataDir).toBe('/var/lib/motrix')
    expect(svc.extraResourceDir).toBe('/usr/share/motrix/extra')
    expect(svc.aria2BinaryPath).toBe('/usr/bin/aria2c')
  })

  it('darwin resolves userDataDir to ~/Library/Application Support/motrix-turbo-server', () => {
    const svc = createNodePlatformServices({
      platform: 'darwin',
      env: {},
      homedir: () => '/home/test',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.userDataDir).toBe(
      path.join(
        '/home/test',
        'Library',
        'Application Support',
        'motrix-turbo-server'
      )
    )
  })

  it('darwin resolves extraResourceDir relative to moduleUrl dist location', () => {
    const svc = createNodePlatformServices({
      platform: 'darwin',
      env: {},
      homedir: () => '/home/test',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.extraResourceDir).toBe(path.join('/fake/repo', 'extra'))
  })

  it('darwin resolves aria2BinaryPath inside extra/darwin/<arch>/aria2c', () => {
    const svc = createNodePlatformServices({
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      homedir: () => '/home/test',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.aria2BinaryPath).toBe(
      path.join('/fake/repo', 'extra', 'darwin', 'arm64', 'aria2c')
    )
  })

  it('win32 uses APPDATA env for userDataDir', () => {
    const svc = createNodePlatformServices({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\T\\AppData\\Roaming' },
      homedir: () => '/fake/home',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.userDataDir).toBe(
      path.join('C:\\Users\\T\\AppData\\Roaming', 'motrix-turbo-server')
    )
  })

  it('win32 falls back to homedir when APPDATA absent', () => {
    const svc = createNodePlatformServices({
      platform: 'win32',
      env: {},
      homedir: () => '/fake/home',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.userDataDir).toBe(path.join('/fake/home', 'motrix-turbo-server'))
  })

  it('win32 aria2BinaryPath ends with aria2c.exe', () => {
    const svc = createNodePlatformServices({
      platform: 'win32',
      arch: 'x64',
      env: {},
      homedir: () => '/fake/home',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.aria2BinaryPath).toContain(
      path.join('extra', 'win32', 'x64', 'aria2c.exe')
    )
  })

  it('env overrides take precedence over defaults on all platforms', () => {
    const svc = createNodePlatformServices({
      platform: 'darwin',
      env: {
        MOTRIX_DATA_DIR: '/custom/data',
        MOTRIX_EXTRA_DIR: '/custom/extra',
        MOTRIX_ARIA2_BIN: '/custom/aria2c',
      },
      homedir: () => '/home/test',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.userDataDir).toBe('/custom/data')
    expect(svc.extraResourceDir).toBe('/custom/extra')
    expect(svc.aria2BinaryPath).toBe('/custom/aria2c')
  })

  it('NODE_ENV=development flips isDev true', () => {
    const svc = createNodePlatformServices({
      env: { NODE_ENV: 'development' },
      platform: 'linux',
      moduleUrl: FAKE_MODULE_URL,
    })
    expect(svc.isDev).toBe(true)
  })
})
