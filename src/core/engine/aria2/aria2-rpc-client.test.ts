import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Aria2RpcClient } from './aria2-rpc-client'
import type { JsonRpcProtocol } from './json-rpc-protocol'
import type { WebSocketTransport } from './web-socket-transport'

// ─── Fake JsonRpcProtocol ────────────────────────────────────
// Records calls and lets tests control responses.

class FakeProtocol {
  calls: Array<{ method: string; params: unknown[] }> = []
  multicallArgs: Array<{ method: string; params: unknown[] }>[] = []
  multicallSettledArgs: Array<{ method: string; params: unknown[] }>[] = []
  notificationHandler: ((method: string, params: unknown[]) => void) | null =
    null

  nextResult: unknown = undefined

  call<T>(method: string, params: unknown[]): Promise<T> {
    this.calls.push({ method, params })
    return Promise.resolve(this.nextResult as T)
  }

  multicallSettled(
    calls: Array<{ method: string; params: unknown[] }>
  ): Promise<PromiseSettledResult<unknown>[]> {
    this.multicallSettledArgs.push(calls)
    return Promise.resolve(
      (this.nextResult as PromiseSettledResult<unknown>[]) ??
        calls.map(() => ({ status: 'fulfilled' as const, value: null }))
    )
  }

  multicall(
    calls: Array<{ method: string; params: unknown[] }>
  ): Promise<unknown[]> {
    this.multicallArgs.push(calls)
    return Promise.resolve(
      (this.nextResult as unknown[]) ?? calls.map(() => null)
    )
  }

  onNotification(handler: (method: string, params: unknown[]) => void): void {
    this.notificationHandler = handler
  }

  // Test helper — simulate a notification from aria2
  _notify(method: string, params: unknown[]) {
    this.notificationHandler?.(method, params)
  }
}

// ─── Fake WebSocketTransport ─────────────────────────────────

class FakeTransport {
  connect = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  disconnect = vi.fn()
  isConnected = vi.fn().mockReturnValue(true)
  send = vi.fn()
  onMessage = vi.fn()
  onClose = vi.fn()
  onError = vi.fn()
}

describe('Aria2RpcClient', () => {
  let fakeTransport: FakeTransport
  let fakeProtocol: FakeProtocol
  let client: Aria2RpcClient

  beforeEach(() => {
    fakeTransport = new FakeTransport()
    fakeProtocol = new FakeProtocol()
    client = new Aria2RpcClient(
      fakeTransport as unknown as WebSocketTransport,
      fakeProtocol as unknown as JsonRpcProtocol,
      'my-secret'
    )
  })

  describe('connect / disconnect', () => {
    it('connects to ws://127.0.0.1:{port}/jsonrpc', async () => {
      await client.connect(16800)

      expect(fakeTransport.connect).toHaveBeenCalledWith(
        'ws://127.0.0.1:16800/jsonrpc'
      )
    })

    it('disconnects the transport', () => {
      client.disconnect()
      expect(fakeTransport.disconnect).toHaveBeenCalled()
    })

    it('delegates isConnected to transport', () => {
      fakeTransport.isConnected.mockReturnValue(true)
      expect(client.isConnected()).toBe(true)

      fakeTransport.isConnected.mockReturnValue(false)
      expect(client.isConnected()).toBe(false)
    })
  })

  describe('secret injection', () => {
    it('injects token:{secret} as first param for aria2 methods', async () => {
      fakeProtocol.nextResult = '2089b05ecca3d829'

      await client.addUri(['http://example.com/file.zip'])

      expect(fakeProtocol.calls).toHaveLength(1)
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.addUri')
      expect(call.params[0]).toBe('token:my-secret')
      expect(call.params[1]).toEqual(['http://example.com/file.zip'])
    })

    it('uses an updated secret for the next authenticated call', async () => {
      await client.addUri(['http://example.com/before.zip'])

      client.setSecret('rotated-secret')
      await client.addUri(['http://example.com/after.zip'])

      expect(fakeProtocol.calls[0]?.params[0]).toBe('token:my-secret')
      expect(fakeProtocol.calls[1]?.params[0]).toBe('token:rotated-secret')
    })

    it('omits token injection from the first startup RPC after the secret is cleared', async () => {
      client.setSecret('')

      await client.changeGlobalOption({ continue: 'true' })

      expect(fakeProtocol.calls[0]).toEqual({
        method: 'aria2.changeGlobalOption',
        params: [{ continue: 'true' }],
      })
    })

    it('does NOT inject secret for system.listMethods', async () => {
      fakeProtocol.nextResult = ['aria2.addUri', 'aria2.remove']

      await client.listMethods()

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('system.listMethods')
      expect(call.params).toEqual([])
    })

    it('does NOT inject secret for system.listNotifications', async () => {
      fakeProtocol.nextResult = ['aria2.onDownloadStart']

      await client.listNotifications()

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('system.listNotifications')
      expect(call.params).toEqual([])
    })
  })

  describe('download management', () => {
    it('addUri sends correct method and params', async () => {
      fakeProtocol.nextResult = 'gid123'
      const uris = ['http://a.com/1.zip', 'http://b.com/1.zip']
      const options = { dir: '/tmp' }

      const gid = await client.addUri(uris, options)

      expect(gid).toBe('gid123')
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.addUri')
      expect(call.params).toEqual(['token:my-secret', uris, options])
    })

    it('addUri omits undefined optional params', async () => {
      fakeProtocol.nextResult = 'gid456'

      await client.addUri(['http://a.com/f.zip'])

      const call = fakeProtocol.calls[0]
      // Should only have token + uris, no trailing undefined
      expect(call.params).toEqual(['token:my-secret', ['http://a.com/f.zip']])
    })

    it('addUri includes position when provided', async () => {
      fakeProtocol.nextResult = 'gid789'

      await client.addUri(['http://a.com/f.zip'], { dir: '/tmp' }, 0)

      const call = fakeProtocol.calls[0]
      expect(call.params).toEqual([
        'token:my-secret',
        ['http://a.com/f.zip'],
        { dir: '/tmp' },
        0,
      ])
    })

    it('addTorrent sends base64 torrent data', async () => {
      fakeProtocol.nextResult = 'gidBt'

      await client.addTorrent('base64data==')

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.addTorrent')
      expect(call.params).toEqual(['token:my-secret', 'base64data=='])
    })

    it('addMetalink sends base64 metalink data', async () => {
      fakeProtocol.nextResult = ['gidMl1']

      await client.addMetalink('mlBase64==')

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.addMetalink')
      expect(call.params).toEqual(['token:my-secret', 'mlBase64=='])
    })
  })

  describe('task control', () => {
    it('remove sends correct GID', async () => {
      fakeProtocol.nextResult = 'gid1'
      await client.remove('gid1')

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.remove')
      expect(call.params).toEqual(['token:my-secret', 'gid1'])
    })

    it('forceRemove sends correct GID', async () => {
      fakeProtocol.nextResult = 'gid1'
      await client.forceRemove('gid1')

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.forceRemove')
      expect(call.params).toEqual(['token:my-secret', 'gid1'])
    })

    it('pause sends correct GID', async () => {
      fakeProtocol.nextResult = 'gid1'
      await client.pause('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.pause')
    })

    it('forcePause sends correct GID', async () => {
      fakeProtocol.nextResult = 'gid1'
      await client.forcePause('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.forcePause')
    })

    it('unpause sends correct GID', async () => {
      fakeProtocol.nextResult = 'gid1'
      await client.unpause('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.unpause')
    })

    it('pauseAll sends no extra params', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.pauseAll()

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.pauseAll')
      expect(call.params).toEqual(['token:my-secret'])
    })

    it('unpauseAll sends no extra params', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.unpauseAll()

      expect(fakeProtocol.calls[0].method).toBe('aria2.unpauseAll')
    })
  })

  describe('status queries', () => {
    it('tellStatus sends GID and optional keys', async () => {
      fakeProtocol.nextResult = { gid: 'abc', status: 'active' }

      await client.tellStatus('abc', ['gid', 'status'])

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.tellStatus')
      expect(call.params).toEqual(['token:my-secret', 'abc', ['gid', 'status']])
    })

    it('tellStatus omits keys when undefined', async () => {
      fakeProtocol.nextResult = { gid: 'abc' }

      await client.tellStatus('abc')

      const call = fakeProtocol.calls[0]
      expect(call.params).toEqual(['token:my-secret', 'abc'])
    })

    it('tellActive sends optional keys', async () => {
      fakeProtocol.nextResult = []
      await client.tellActive(['gid'])

      expect(fakeProtocol.calls[0].method).toBe('aria2.tellActive')
      expect(fakeProtocol.calls[0].params).toEqual(['token:my-secret', ['gid']])
    })

    it('tellWaiting sends offset and num', async () => {
      fakeProtocol.nextResult = []
      await client.tellWaiting(0, 100)

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.tellWaiting')
      expect(call.params).toEqual(['token:my-secret', 0, 100])
    })

    it('tellStopped sends offset and num', async () => {
      fakeProtocol.nextResult = []
      await client.tellStopped(0, 50)

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.tellStopped')
      expect(call.params).toEqual(['token:my-secret', 0, 50])
    })

    it('getFiles sends GID', async () => {
      fakeProtocol.nextResult = []
      await client.getFiles('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.getFiles')
    })

    it('getUris sends GID', async () => {
      fakeProtocol.nextResult = []
      await client.getUris('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.getUris')
    })
  })

  describe('global operations', () => {
    it('getGlobalStat sends correctly', async () => {
      fakeProtocol.nextResult = {
        downloadSpeed: '0',
        numActive: '0',
      }

      await client.getGlobalStat()

      expect(fakeProtocol.calls[0].method).toBe('aria2.getGlobalStat')
      expect(fakeProtocol.calls[0].params).toEqual(['token:my-secret'])
    })

    it('getGlobalOption sends correctly', async () => {
      fakeProtocol.nextResult = {}
      await client.getGlobalOption()

      expect(fakeProtocol.calls[0].method).toBe('aria2.getGlobalOption')
    })

    it('changeGlobalOption sends option map', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.changeGlobalOption({
        'max-concurrent-downloads': '10',
      })

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.changeGlobalOption')
      expect(call.params).toEqual([
        'token:my-secret',
        { 'max-concurrent-downloads': '10' },
      ])
    })

    it('getOption sends GID', async () => {
      fakeProtocol.nextResult = {}
      await client.getOption('gid1')

      expect(fakeProtocol.calls[0].method).toBe('aria2.getOption')
    })

    it('changeOption sends GID and options', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.changeOption('gid1', { dir: '/downloads' })

      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.changeOption')
      expect(call.params).toEqual([
        'token:my-secret',
        'gid1',
        { dir: '/downloads' },
      ])
    })
  })

  describe('system methods', () => {
    it('getVersion sends correctly', async () => {
      fakeProtocol.nextResult = {
        version: '1.37.0',
        enabledFeatures: [],
      }
      await client.getVersion()

      expect(fakeProtocol.calls[0].method).toBe('aria2.getVersion')
    })

    it('getSessionInfo sends correctly', async () => {
      fakeProtocol.nextResult = { sessionId: 'abc' }
      await client.getSessionInfo()

      expect(fakeProtocol.calls[0].method).toBe('aria2.getSessionInfo')
    })

    it('shutdown sends correctly', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.shutdown()

      expect(fakeProtocol.calls[0].method).toBe('aria2.shutdown')
    })

    it('forceShutdown sends correctly', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.forceShutdown()

      expect(fakeProtocol.calls[0].method).toBe('aria2.forceShutdown')
    })

    it('saveSession sends correctly', async () => {
      fakeProtocol.nextResult = 'OK'
      await client.saveSession()

      expect(fakeProtocol.calls[0].method).toBe('aria2.saveSession')
    })
  })

  describe('multicall', () => {
    it('injects secret into each sub-call before delegating', async () => {
      fakeProtocol.nextResult = [[], []]

      await client.multicall([
        { method: 'aria2.tellActive', params: [] },
        { method: 'aria2.getGlobalStat', params: [] },
      ])

      expect(fakeProtocol.multicallArgs).toHaveLength(1)
      expect(fakeProtocol.multicallArgs[0]).toEqual([
        { method: 'aria2.tellActive', params: ['token:my-secret'] },
        { method: 'aria2.getGlobalStat', params: ['token:my-secret'] },
      ])
    })

    it('multicallSettled injects the same per-entry secret', async () => {
      fakeProtocol.nextResult = undefined

      await client.multicallSettled([
        { method: 'aria2.removeDownloadResult', params: ['gid-1'] },
        { method: 'system.listMethods', params: [] },
      ])

      expect(fakeProtocol.multicallSettledArgs).toHaveLength(1)
      expect(fakeProtocol.multicallSettledArgs[0]).toEqual([
        {
          method: 'aria2.removeDownloadResult',
          params: ['token:my-secret', 'gid-1'],
        },
        { method: 'system.listMethods', params: [] },
      ])
    })

    it('exempts system.listMethods / listNotifications from secret injection', async () => {
      fakeProtocol.nextResult = [[], []]

      await client.multicall([
        { method: 'system.listMethods', params: [] },
        { method: 'aria2.tellActive', params: [] },
      ])

      expect(fakeProtocol.multicallArgs[0]).toEqual([
        { method: 'system.listMethods', params: [] },
        { method: 'aria2.tellActive', params: ['token:my-secret'] },
      ])
    })
  })

  describe('SQLite3-Persistence RPCs', () => {
    it('getDownloadResultCount sends method and filter', async () => {
      fakeProtocol.nextResult = { count: '42' }
      const result = await client.getDownloadResultCount({
        status: 'complete',
        since: 1700_000_000_000,
      })
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.getDownloadResultCount')
      expect(call.params).toEqual([
        'token:my-secret',
        { status: 'complete', since: 1700_000_000_000 },
      ])
      expect(result).toEqual({ count: '42' })
    })

    it('getDownloadResultCount omits filter when undefined', async () => {
      fakeProtocol.nextResult = { count: '0' }
      await client.getDownloadResultCount()
      const call = fakeProtocol.calls[0]
      expect(call.params).toEqual(['token:my-secret'])
    })

    it('searchDownloadResult sends required and optional params', async () => {
      fakeProtocol.nextResult = []
      await client.searchDownloadResult({ pathLike: '%video%' }, 0, 50, [
        'gid',
        'status',
      ])
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.searchDownloadResult')
      expect(call.params).toEqual([
        'token:my-secret',
        { pathLike: '%video%' },
        0,
        50,
        ['gid', 'status'],
      ])
    })

    it('searchDownloadResult omits keys when undefined', async () => {
      fakeProtocol.nextResult = []
      await client.searchDownloadResult({}, 0, 10)
      const call = fakeProtocol.calls[0]
      expect(call.params).toEqual(['token:my-secret', {}, 0, 10])
    })

    it('exportSession sends path', async () => {
      fakeProtocol.nextResult = 'OK'
      const result = await client.exportSession('/tmp/dump.session')
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.exportSession')
      expect(call.params).toEqual(['token:my-secret', '/tmp/dump.session'])
      expect(result).toBe('OK')
    })

    it('requeueDownloadResult sends gid and optional overrides', async () => {
      fakeProtocol.nextResult = { gid: 'NEW123', strategy: 'source-uri' }
      const result = await client.requeueDownloadResult('OLD456', {
        dir: '/downloads',
      })
      const call = fakeProtocol.calls[0]
      expect(call.method).toBe('aria2.requeueDownloadResult')
      expect(call.params).toEqual([
        'token:my-secret',
        'OLD456',
        { dir: '/downloads' },
      ])
      expect(result).toEqual({ gid: 'NEW123', strategy: 'source-uri' })
    })

    it('requeueDownloadResult omits overrides when undefined', async () => {
      fakeProtocol.nextResult = { gid: 'X', strategy: 'synthesized-magnet' }
      await client.requeueDownloadResult('OLD789')
      const call = fakeProtocol.calls[0]
      expect(call.params).toEqual(['token:my-secret', 'OLD789'])
    })
  })

  describe('changePosition', () => {
    it('sends gid, pos, and how in order', async () => {
      fakeProtocol.nextResult = 3
      const result = await client.changePosition('gid-1', -1, 'POS_CUR')
      expect(fakeProtocol.calls[0].method).toBe('aria2.changePosition')
      expect(fakeProtocol.calls[0].params).toEqual([
        'token:my-secret',
        'gid-1',
        -1,
        'POS_CUR',
      ])
      expect(result).toBe(3)
    })
  })

  describe('notification events', () => {
    it('routes onDownloadStart notification', () => {
      const handler = vi.fn()
      client.onDownloadStart(handler)

      fakeProtocol._notify('aria2.onDownloadStart', [{ gid: 'abc' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'abc' })
    })

    it('routes onDownloadComplete notification', () => {
      const handler = vi.fn()
      client.onDownloadComplete(handler)

      fakeProtocol._notify('aria2.onDownloadComplete', [{ gid: 'def' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'def' })
    })

    it('routes onDownloadPause notification', () => {
      const handler = vi.fn()
      client.onDownloadPause(handler)

      fakeProtocol._notify('aria2.onDownloadPause', [{ gid: 'ghi' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'ghi' })
    })

    it('routes onDownloadStop notification', () => {
      const handler = vi.fn()
      client.onDownloadStop(handler)

      fakeProtocol._notify('aria2.onDownloadStop', [{ gid: 'jkl' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'jkl' })
    })

    it('routes onDownloadError notification', () => {
      const handler = vi.fn()
      client.onDownloadError(handler)

      fakeProtocol._notify('aria2.onDownloadError', [{ gid: 'mno' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'mno' })
    })

    it('routes onBtDownloadComplete notification', () => {
      const handler = vi.fn()
      client.onBtDownloadComplete(handler)

      fakeProtocol._notify('aria2.onBtDownloadComplete', [{ gid: 'pqr' }])

      expect(handler).toHaveBeenCalledWith({ gid: 'pqr' })
    })

    it('ignores notifications with no matching handler', () => {
      // Should not throw
      fakeProtocol._notify('aria2.onDownloadStart', [{ gid: 'xyz' }])
    })

    it('supports multiple handlers for the same notification', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      client.onDownloadComplete(handler1)
      client.onDownloadComplete(handler2)

      fakeProtocol._notify('aria2.onDownloadComplete', [{ gid: 'multi' }])

      expect(handler1).toHaveBeenCalledWith({ gid: 'multi' })
      expect(handler2).toHaveBeenCalledWith({ gid: 'multi' })
    })

    it('returns an idempotent unsubscribe handle', () => {
      const handler = vi.fn()
      const unsubscribe = client.onDownloadComplete(handler)

      unsubscribe()
      unsubscribe()
      fakeProtocol._notify('aria2.onDownloadComplete', [{ gid: 'gone' }])

      expect(handler).not.toHaveBeenCalled()
    })

    it('uses a stable fan-out snapshot when a listener unsubscribes another', () => {
      const first = vi.fn()
      const second = vi.fn()
      let unsubscribeSecond: () => void = () => undefined
      client.onDownloadComplete((event) => {
        first(event)
        unsubscribeSecond()
      })
      unsubscribeSecond = client.onDownloadComplete(second)

      fakeProtocol._notify('aria2.onDownloadComplete', [{ gid: 'first' }])
      fakeProtocol._notify('aria2.onDownloadComplete', [{ gid: 'second' }])

      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledWith({ gid: 'first' })
    })
  })
})
