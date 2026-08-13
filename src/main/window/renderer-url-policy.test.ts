import { describe, expect, it, vi } from 'vitest'

import { createRendererUrlPolicy } from './renderer-url-policy'

function createWindowLoader() {
  return {
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
  }
}

describe('renderer URL policy', () => {
  it('ignores a hostile dev-server environment in packaged builds', () => {
    const policy = createRendererUrlPolicy({
      isPackaged: true,
      appPath: '/opt/Motrix/resources/app.asar',
      devServerUrl: 'https://attacker.example/',
    })
    const win = createWindowLoader()

    policy.loadWindow(win as never, '?w=main&locale=en-US')

    expect(Object.isFrozen(policy)).toBe(true)
    expect(policy.isDevelopmentServer).toBe(false)
    expect(policy.devServerOrigin).toBeNull()
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledWith(
      '/opt/Motrix/resources/app.asar/dist/renderer/index.html',
      { search: '?w=main&locale=en-US' }
    )
    expect(
      policy.isTrustedUrl(
        'file:///opt/Motrix/resources/app.asar/dist/renderer/index.html?w=main'
      )
    ).toBe(true)
    expect(policy.isTrustedUrl('https://attacker.example/')).toBe(false)
  })

  it.each([
    'http://0.0.0.0:5173/',
    'http://192.168.1.20:5173/',
    'https://attacker.example/',
  ])('rejects a non-loopback development origin: %s', (devServerUrl) => {
    expect(() =>
      createRendererUrlPolicy({
        isPackaged: false,
        appPath: '/app',
        devServerUrl,
      })
    ).toThrow('loopback hostname')
  })

  it.each([
    'http://localhost:5173/',
    'http://127.0.0.1:5173/',
    'https://[::1]:5173/',
  ])('trusts only the resolved loopback origin: %s', (devServerUrl) => {
    const policy = createRendererUrlPolicy({
      isPackaged: false,
      appPath: '/app',
      devServerUrl,
    })
    const win = createWindowLoader()

    policy.loadWindow(win as never, '?w=add-task&locale=zh-CN')

    expect(policy.devServerOrigin).toBe(new URL(devServerUrl).origin)
    expect(win.loadFile).not.toHaveBeenCalled()
    expect(win.loadURL).toHaveBeenCalledWith(
      `${new URL(devServerUrl).origin}/?w=add-task&locale=zh-CN`
    )
    expect(policy.isTrustedUrl(`${new URL(devServerUrl).origin}/?w=main`)).toBe(
      true
    )
    expect(policy.isTrustedUrl('http://localhost:6553/')).toBe(false)
  })

  it.each([
    'file:///tmp/dev.html',
    'ftp://localhost:5173/',
    'http://localhost:5173/path',
    'http://localhost:5173/?token=unsafe',
  ])('rejects a malformed development origin: %s', (devServerUrl) => {
    expect(() =>
      createRendererUrlPolicy({
        isPackaged: false,
        appPath: '/app',
        devServerUrl,
      })
    ).toThrow(/VITE_DEV_SERVER_URL/)
  })

  it('rejects renderer routes that are not query-only', () => {
    const policy = createRendererUrlPolicy({
      isPackaged: true,
      appPath: '/app',
    })
    const win = createWindowLoader()

    expect(() => policy.loadWindow(win as never, '/other.html')).toThrow(
      'query string'
    )
    expect(() => policy.loadWindow(win as never, '?w=main#fragment')).toThrow(
      'query string'
    )
  })
})
