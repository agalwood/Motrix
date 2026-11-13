import { describe, expect, it, vi } from 'vitest'
import type { JsonRpcProtocol } from '../aria2/json-rpc-protocol'
import type { WebSocketTransport } from '../aria2/web-socket-transport'
import { TaijiAdapter } from './taiji-adapter'
import { TaijiRpcClient } from './taiji-rpc-client'

function fixture() {
  let notify: (method: string, params: unknown[]) => void = () => {}
  const protocol = {
    call: vi.fn().mockResolvedValue('gid'),
    multicall: vi.fn().mockResolvedValue(['OK']),
    multicallSettled: vi
      .fn()
      .mockResolvedValue([{ status: 'fulfilled', value: 'OK' }]),
    onNotification: vi.fn((handler) => {
      notify = handler
    }),
  }
  const rpc = new TaijiRpcClient(
    {} as WebSocketTransport,
    protocol as unknown as JsonRpcProtocol,
    'secret'
  )
  return {
    rpc,
    protocol,
    notify: (method: string) => notify(method, [{ gid: 'gid' }]),
  }
}

describe('native taiji RPC boundary', () => {
  it('projects native seed/check status consistently in single and batched replies', async () => {
    const { rpc, protocol } = fixture()
    const seed = { gid: 'seed', status: 'seeding', bittorrent: {} }
    protocol.call.mockResolvedValue(seed)
    expect(await rpc.tellStatus('seed')).toEqual({
      ...seed,
      status: 'active',
      seeder: 'true',
    })
    protocol.multicall.mockResolvedValue([
      [seed, { gid: 'check', status: 'checking' }],
    ])
    expect(
      await rpc.multicall([{ method: 'aria2.tellWaiting', params: [0, 100] }])
    ).toEqual([
      [
        { ...seed, status: 'active', seeder: 'true' },
        { gid: 'check', status: 'waiting' },
      ],
    ])
    protocol.multicallSettled.mockResolvedValue([
      { status: 'fulfilled', value: seed },
    ])
    expect(
      await rpc.multicallSettled([
        { method: 'aria2.tellStatus', params: ['seed'] },
      ])
    ).toEqual([
      {
        status: 'fulfilled',
        value: { ...seed, status: 'active', seeder: 'true' },
      },
    ])
    protocol.call.mockResolvedValue({
      numActive: '2',
      numSeeding: '3',
      numChecking: '1',
    })
    expect((await rpc.getGlobalStat()).numActive).toBe('6')
  })

  it('uses native methods and authenticates each batch entry', async () => {
    const { rpc, protocol } = fixture()
    await rpc.addUriWithCookies(['https://example.com/file'], [], {
      pause: 'true',
    })
    expect(protocol.call).toHaveBeenLastCalledWith(
      'taiji.addUriWithCookies',
      ['token:secret', ['https://example.com/file'], [], { pause: 'true' }],
      undefined
    )
    await rpc.multicall([
      { method: 'aria2.changeOption', params: ['gid', { pause: 'true' }] },
    ])
    expect(protocol.multicall).toHaveBeenCalledWith([
      {
        method: 'taiji.changeOption',
        params: ['token:secret', 'gid', { pause: 'true' }],
      },
    ])
    await rpc.multicallSettled([
      { method: 'aria2.removeDownloadResult', params: ['gid'] },
    ])
    expect(protocol.multicallSettled).toHaveBeenCalledWith([
      { method: 'taiji.removeDownloadResult', params: ['token:secret', 'gid'] },
    ])
    await rpc.listMethods()
    expect(protocol.call).toHaveBeenLastCalledWith(
      'system.listMethods',
      [],
      undefined
    )
  })

  it('translates proxy credentials for native taiji without mutating caller options', async () => {
    const { rpc, protocol } = fixture()
    const options = {
      'all-proxy': 'http://127.0.0.1:8888',
      'all-proxy-user': 'user',
      'all-proxy-passwd': 'p@ss',
    }
    await rpc.addUri(['https://example.com/file'], options)
    expect(protocol.call).toHaveBeenLastCalledWith(
      'taiji.addUri',
      [
        'token:secret',
        ['https://example.com/file'],
        { 'all-proxy': 'http://user:p%40ss@127.0.0.1:8888/' },
      ],
      undefined
    )
    await rpc.multicall([
      { method: 'aria2.changeGlobalOption', params: [options] },
    ])
    expect(protocol.multicall).toHaveBeenLastCalledWith([
      {
        method: 'taiji.changeGlobalOption',
        params: [
          'token:secret',
          { 'all-proxy': 'http://user:p%40ss@127.0.0.1:8888/' },
        ],
      },
    ])
    expect(options['all-proxy-passwd']).toBe('p@ss')
    expect(options['all-proxy']).toBe('http://127.0.0.1:8888')
  })

  it('serializes cumulative headers instead of letting taiji ignore array-valued options', async () => {
    const { rpc, protocol } = fixture()
    const header = ['Authorization: Bearer test-only', 'Accept: */*']
    await rpc.addUri(['https://example.com/file'], { header })
    expect(protocol.call).toHaveBeenLastCalledWith(
      'taiji.addUri',
      [
        'token:secret',
        ['https://example.com/file'],
        { header: header.join('\n') },
      ],
      undefined
    )
    expect(header).toHaveLength(2)
    await expect(
      rpc.addUri(['https://example.com/file'], {
        header: ['X: one\nInjected: two'],
      })
    ).rejects.toThrow('option array')
  })

  it('normalizes native events once, ignoring legacy events and honoring unsubscribe', () => {
    const { rpc, notify } = fixture()
    const callback = vi.fn()
    const unsubscribe = rpc.onDownloadComplete(callback)
    notify('aria2.onDownloadComplete')
    notify('taiji.onDownloadComplete')
    notify('taiji.onHttpOutputReady')
    unsubscribe()
    notify('taiji.onDownloadComplete')
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenLastCalledWith({ gid: 'gid' })
  })

  it('rejects foreign identity and does not hide a failed native probe', async () => {
    const { rpc, protocol } = fixture()
    const adapter = new TaijiAdapter(rpc)
    protocol.call.mockResolvedValue({
      version: '1.37.0',
      enabledFeatures: ['BitTorrent'],
    })
    await expect(adapter.connect()).rejects.toThrow('identify itself as taiji')
    expect(adapter.getCapabilities().bt).toBe(false)
    protocol.call.mockRejectedValue(new Error('Unauthorized'))
    await expect(adapter.connect()).rejects.toThrow('Unauthorized')
    adapter.dispose()
  })

  it('clears capabilities before a failed reconnect and on disconnect', async () => {
    const { rpc, protocol } = fixture()
    const adapter = new TaijiAdapter(rpc)
    protocol.call.mockResolvedValue({
      version: 'taiji/0.1.0',
      enabledFeatures: ['HTTP', 'BitTorrent'],
    })
    await adapter.connect()
    expect(adapter.getCapabilities().bt).toBe(true)
    protocol.call.mockRejectedValueOnce(new Error('Disconnected'))
    await expect(adapter.connect()).rejects.toThrow('Disconnected')
    expect(adapter.getCapabilities().bt).toBe(false)
    expect(adapter.getFeatureReport().version).toBe('unknown')
    await adapter.connect()
    await adapter.disconnect()
    expect(adapter.getCapabilities().http).toBe(false)
    adapter.dispose()
  })

  it('blocks fork-only operations before any batch can mutate tasks', async () => {
    const { rpc, protocol } = fixture()
    await expect(
      rpc.multicallSettled([
        { method: 'aria2.remove', params: ['gid'] },
        { method: 'aria2.importLegacyCheckpointV1', params: [] },
      ])
    ).rejects.toThrow('legacy engine method')
    await expect(rpc.exportSession('/tmp/old.session')).rejects.toThrow(
      'legacy engine method'
    )
    expect(protocol.multicallSettled).not.toHaveBeenCalled()
    expect(protocol.call).not.toHaveBeenCalled()
  })

  it('rejects incompatible file adoption and torrent output mapping before dispatch', async () => {
    const { rpc, protocol } = fixture()
    const adapter = new TaijiAdapter(rpc)
    await expect(
      adapter.createDownload({
        uris: ['https://example.com/file'],
        saveDir: '/tmp',
        resumePolicy: 'sequential-prefix',
      })
    ).rejects.toThrow('Legacy file adoption')
    await expect(
      adapter.addTorrent({
        metadata: new Uint8Array(),
        saveDir: '/tmp',
        outputRoot: '/tmp/output',
        outputFilePaths: [{ fileIndex: 0, relativePath: '../escape' }],
      })
    ).rejects.toThrow('output mapping')
    expect(protocol.call).not.toHaveBeenCalled()
    adapter.dispose()
  })
})
