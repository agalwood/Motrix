import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  type LocalProxyServerFactory,
  ProxyBridgeManager,
} from './proxy-bridge-manager'

const enabledProxy = {
  ...DEFAULT_PROXY_SETTINGS,
  enabled: true,
  host: 'proxy.example.com',
  port: 1080,
}

function makeServerFactory() {
  let getUpstreamProxyUrl = () => ''
  let authorize = (_username: string, _password: string) => false
  const server = {
    port: 43123,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(true),
  }
  const factory: LocalProxyServerFactory = vi.fn(
    (getUpstream, isAuthorized) => {
      getUpstreamProxyUrl = getUpstream
      authorize = isAuthorized
      return server
    }
  )
  return {
    factory,
    server,
    getUpstream: () => getUpstreamProxyUrl(),
    isAuthorized: (username: string, password: string) =>
      authorize(username, password),
  }
}

function makeManager(factory: LocalProxyServerFactory) {
  let generation = 0
  return new ProxyBridgeManager(factory, () => {
    generation += 1
    return {
      username: `local-user-${generation}`,
      password: `local-password-${generation}`,
    }
  })
}

describe('ProxyBridgeManager', () => {
  it('passes HTTP download proxies directly to aria2', async () => {
    const { factory } = makeServerFactory()
    const manager = makeManager(factory)

    await expect(
      manager.resolveForDownload({
        ...enabledProxy,
        protocol: 'http',
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).resolves.toEqual({
      allProxy: 'http://proxy.example.com:1080',
      noProxy: '',
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it('converts a SOCKS5 download proxy to a loopback HTTP endpoint', async () => {
    const { factory, server, getUpstream, isAuthorized } = makeServerFactory()
    const manager = makeManager(factory)

    await expect(
      manager.resolveForDownload({
        ...enabledProxy,
        protocol: 'socks5',
        user: 'a@b',
        password: 'p:s',
        bypass: ['localhost', '127.0.0.1'],
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).resolves.toEqual({
      allProxy: 'http://local-user-1:local-password-1@127.0.0.1:43123',
      noProxy: 'localhost,127.0.0.1',
    })
    expect(server.listen).toHaveBeenCalledOnce()
    expect(getUpstream()).toBe('socks5://a%40b:p%3As@proxy.example.com:1080')
    expect(isAuthorized('local-user-1', 'local-password-1')).toBe(true)
    expect(isAuthorized('', '')).toBe(false)
    expect(isAuthorized('local-user-1', 'wrong')).toBe(false)
  })

  it('reuses the listener and switches new requests to the latest upstream', async () => {
    const { factory, server, getUpstream } = makeServerFactory()
    const manager = makeManager(factory)
    const first = {
      ...enabledProxy,
      protocol: 'socks5' as const,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }

    await manager.resolveForDownload(first)
    await manager.resolveForDownload({ ...first, host: 'new.example.com' })

    expect(factory).toHaveBeenCalledOnce()
    expect(server.listen).toHaveBeenCalledOnce()
    expect(getUpstream()).toBe('socks5://new.example.com:1080')
  })

  it('keeps the listener while another SOCKS5 bridge scope still needs it', async () => {
    const { factory, server } = makeServerFactory()
    const manager = makeManager(factory)

    await manager.resolveForDownload({
      ...enabledProxy,
      protocol: 'socks5',
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })
    await expect(
      manager.resolveForDownload({
        ...enabledProxy,
        protocol: 'socks5',
        scopes: { download: false, updateApp: false, updateTrackers: true },
      })
    ).resolves.toBeNull()

    expect(factory).toHaveBeenCalledOnce()
    expect(server.close).not.toHaveBeenCalled()
  })

  it('uses the bridge for SOCKS5 tracker fetches', async () => {
    const { factory } = makeServerFactory()
    const manager = makeManager(factory)

    await expect(
      manager.resolveForFetch({
        ...enabledProxy,
        protocol: 'socks5',
        scopes: { download: false, updateApp: false, updateTrackers: true },
      })
    ).resolves.toBe('http://local-user-1:local-password-1@127.0.0.1:43123')
  })

  it('does not start the bridge when the requested scope is off', async () => {
    const { factory } = makeServerFactory()
    const manager = makeManager(factory)

    await expect(
      manager.resolveForDownload({
        ...enabledProxy,
        protocol: 'socks5',
      })
    ).resolves.toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('revokes credentials and clears the upstream before stopping an unused bridge', async () => {
    const { factory, server, getUpstream, isAuthorized } = makeServerFactory()
    let finishClose: ((value: boolean) => void) | undefined
    server.close.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishClose = resolve
        })
    )
    const manager = makeManager(factory)
    await manager.resolveForDownload({
      ...enabledProxy,
      protocol: 'socks5',
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })

    const stopping = manager.reconcile({
      ...enabledProxy,
      protocol: 'http',
      scopes: { download: true, updateApp: false, updateTrackers: true },
    })
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledWith(true))

    expect(getUpstream()).toBe('')
    expect(isAuthorized('local-user-1', 'local-password-1')).toBe(false)
    finishClose?.(true)
    await stopping
  })

  it('closes a listener that finishes starting after close is requested', async () => {
    const { factory, server, isAuthorized } = makeServerFactory()
    let finishListen: (() => void) | undefined
    server.listen.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishListen = resolve
        })
    )
    const manager = makeManager(factory)

    const resolving = manager.resolveForDownload({
      ...enabledProxy,
      protocol: 'socks5',
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })
    await vi.waitFor(() => expect(server.listen).toHaveBeenCalledOnce())
    const closing = manager.close()

    finishListen?.()
    await resolving
    await closing

    expect(server.close).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledWith(true)
    expect(isAuthorized('local-user-1', 'local-password-1')).toBe(false)
  })

  it('serializes concurrent resolves onto one listener', async () => {
    const { factory, server } = makeServerFactory()
    const manager = makeManager(factory)
    const settings = {
      ...enabledProxy,
      protocol: 'socks5' as const,
      scopes: { download: true, updateApp: false, updateTrackers: true },
    }

    const [downloadProxy, fetchProxy] = await Promise.all([
      manager.resolveForDownload(settings),
      manager.resolveForFetch(settings),
    ])

    expect(downloadProxy?.allProxy).toBe(fetchProxy)
    expect(factory).toHaveBeenCalledOnce()
    expect(server.listen).toHaveBeenCalledOnce()
  })

  it('force-closes active bridge connections during shutdown', async () => {
    const { factory, server } = makeServerFactory()
    const manager = makeManager(factory)
    await manager.resolveForFetch({
      ...enabledProxy,
      protocol: 'socks5',
      scopes: { download: false, updateApp: false, updateTrackers: true },
    })

    await manager.close()
    await manager.close()

    expect(server.close).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledWith(true)
  })
})
