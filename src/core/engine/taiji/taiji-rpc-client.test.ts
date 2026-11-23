import { describe, expect, it, vi } from 'vitest'
import type { JsonRpcProtocol } from '../aria2/json-rpc-protocol'
import { TaskFileMetadata } from '../aria2/task-file-metadata'
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
  it.each([
    [
      'video-only',
      [
        ['movie.mkv', false],
        ['trailer.mp4', false],
      ],
      true,
    ],
    [
      'mixed files',
      [
        ['movie.mkv', false],
        ['readme.txt', false],
      ],
      false,
    ],
    [
      'video with padding',
      [
        ['movie.mkv', false],
        ['.pad/1', true],
      ],
      true,
    ],
  ] as const)(
    'commits preview intent atomically for %s magnet selections',
    async (_label, entries, preview) => {
      const { rpc, protocol } = fixture()
      const adapter = new TaijiAdapter(rpc)
      vi.spyOn(rpc, 'getFiles').mockResolvedValue(
        entries.map(([name, padding], index) => ({
          index: String(index + 1),
          path: `/downloads/bundle/${name}`,
          length: '1',
          completedLength: '0',
          selected: 'true',
          padding: String(padding),
          uris: [],
        }))
      )
      vi.spyOn(rpc, 'getTorrentManifest').mockResolvedValue({
        data: 'ZGU=',
        awaitingSelection: true,
        manifest: {
          infoHash: 'a'.repeat(40),
          v1: 'a'.repeat(40),
          v2: null,
          name: 'bundle',
          multiFile: true,
          isPrivate: false,
          verificationReady: true,
          files: entries.map(([name, padding], index) => ({
            index,
            components: ['bundle', ...name.split('/')],
            length: 1,
            padding,
          })),
        },
      })
      await adapter.confirmTorrentSelection('gid', {
        saveDir: '/downloads',
        selectedFiles: [0],
        outputFilePaths: [{ fileIndex: 0, relativePath: 'movie.mkv' }],
      })
      const call = protocol.call.mock.calls.find(
        ([method]) => method === 'taiji.confirmTorrentSelection'
      )!
      expect(
        (call[1][2] as Record<string, string>)['bt-prioritize-piece']
      ).toBe(preview ? 'head=10M,tail=10M' : undefined)
      expect((call[1][2] as Record<string, string>)['select-file']).toBe('1')
      expect(
        protocol.call.mock.calls.some(([method]) => method === 'taiji.unpause')
      ).toBe(false)
      adapter.dispose()
    }
  )

  it('edits a task-level source ledger in the native namespace and invalidates file metadata', async () => {
    const { rpc, protocol } = fixture()
    protocol.call.mockResolvedValue([1, 2])
    const invalidate = vi.fn()
    const unsubscribe = rpc.onTaskMetadataChanged(invalidate)
    try {
      await rpc.replaceUris(
        'gid',
        ['https://old.test/file'],
        ['https://one.test/file', 'https://two.test/file']
      )
      expect(protocol.call).toHaveBeenCalledWith(
        'taiji.changeUri',
        [
          'token:secret',
          'gid',
          1,
          ['https://old.test/file'],
          ['https://one.test/file', 'https://two.test/file'],
          0,
        ],
        undefined
      )
      expect(invalidate).toHaveBeenCalledWith('gid')
    } finally {
      unsubscribe()
    }
  })

  it('rejects no-op receipts and refreshes metadata even when the reply is lost', async () => {
    const { rpc, protocol } = fixture()
    const invalidate = vi.fn()
    const unsubscribe = rpc.onTaskMetadataChanged(invalidate)
    try {
      protocol.call
        .mockResolvedValueOnce([0, 0])
        .mockRejectedValueOnce(new Error('timeout'))
      await expect(
        rpc.replaceUris(
          'gid',
          ['https://old.test/file'],
          ['https://new.test/file']
        )
      ).rejects.toThrow('task.sources.changed')
      await expect(
        rpc.replaceUris(
          'gid',
          ['https://old.test/file'],
          ['https://new.test/file']
        )
      ).rejects.toThrow('timeout')
      expect(invalidate).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('delivers native metadata readiness without status or feature queries', () => {
    const { rpc, protocol, notify } = fixture()
    const adapter = new TaijiAdapter(rpc)
    const ready = vi.fn()
    const unsubscribe = adapter.onTorrentMetadataReady(ready)
    notify('taiji.onDownloadPause')
    expect(ready).not.toHaveBeenCalled()
    notify('taiji.onTorrentMetadataReady')
    expect(ready).toHaveBeenCalledExactlyOnceWith('gid')
    expect(protocol.call).not.toHaveBeenCalled()
    unsubscribe()
    notify('taiji.onTorrentMetadataReady')
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('releases metadata-ready subscriptions when the adapter is disposed', () => {
    const { rpc, notify } = fixture()
    const adapter = new TaijiAdapter(rpc)
    const ready = vi.fn()
    adapter.onTorrentMetadataReady(ready)
    adapter.dispose()
    notify('taiji.onTorrentMetadataReady')
    expect(ready).not.toHaveBeenCalled()
    const late = vi.fn()
    adapter.onTorrentMetadataReady(late)
    notify('taiji.onTorrentMetadataReady')
    expect(late).not.toHaveBeenCalled()
  })

  it('isolates a failing metadata-ready subscriber', () => {
    const { rpc, notify } = fixture()
    const adapter = new TaijiAdapter(rpc)
    const ready = vi.fn()
    adapter.onTorrentMetadataReady(() => {
      throw new Error('consumer failed')
    })
    adapter.onTorrentMetadataReady(ready)
    expect(() => notify('taiji.onTorrentMetadataReady')).not.toThrow()
    expect(ready).toHaveBeenCalledExactlyOnceWith('gid')
    adapter.dispose()
  })

  it('reads the synchronized manifest contract directly, including v2 proof readiness', async () => {
    const { rpc, protocol } = fixture()
    const manifest = {
      infoHash: 'a'.repeat(64),
      v1: null,
      v2: 'a'.repeat(64),
      name: 'file.bin',
      multiFile: false,
      isPrivate: false,
      verificationReady: false,
      files: [
        { index: 0, components: ['file.bin'], length: 65536, padding: false },
      ],
    }
    protocol.call.mockResolvedValue({
      data: 'ZGU=',
      awaitingSelection: true,
      manifest,
    })
    const adapter = new TaijiAdapter(rpc)
    expect((await adapter.getTorrentMetadata('gid')).manifest).toEqual(manifest)
    expect(protocol.call).toHaveBeenCalledExactlyOnceWith(
      'taiji.getTorrentManifest',
      ['token:secret', 'gid'],
      undefined
    )
    protocol.call.mockResolvedValue({ data: 'ZGU=', awaitingSelection: true })
    await expect(adapter.getTorrentMetadata('gid')).rejects.toThrow()
  })

  it('prepares discovery on connection without waiting for preparation', async () => {
    const { rpc, protocol } = fixture()
    protocol.call.mockImplementation(async (method) => {
      if (method === 'taiji.getVersion')
        return {
          version: 'taiji/0.4.3',
          enabledFeatures: ['BitTorrent'],
        }
      if (method === 'taiji.getCapabilities')
        return {
          schemaVersion: 1,
          version: 'taiji/0.4.3',
          rpcExtensions: ['taiji.moveStorage'],
        }
      if (method === 'taiji.prepareBitTorrent') return new Promise(() => {})
      return 'OK'
    })
    const adapter = new TaijiAdapter(rpc)
    await adapter.connect()
    expect(adapter.getFeatureReport().hasMoveStorage).toBe(true)
    expect(protocol.call).toHaveBeenCalledWith(
      'taiji.prepareBitTorrent',
      ['token:secret'],
      undefined
    )
    protocol.call.mockClear()
    await adapter.connect()
    expect(protocol.call).toHaveBeenCalledWith(
      'taiji.prepareBitTorrent',
      ['token:secret'],
      undefined
    )
    adapter.dispose()
  })

  it('notifies network changes through the authenticated native method', async () => {
    const { rpc, protocol } = fixture()
    protocol.call.mockResolvedValue('OK')
    expect(await rpc.notifyNetworkChange()).toBe('OK')
    expect(protocol.call).toHaveBeenCalledWith(
      'taiji.notifyNetworkChange',
      ['token:secret'],
      undefined
    )
  })
  it('discards pre-confirmation file reads and clears accepted pause state on the same GID', async () => {
    const { rpc, protocol } = fixture()
    const cache = new TaskFileMetadata(rpc)
    rpc.onTaskMetadataChanged((gid) => cache.invalidate(gid))
    const files = (selected: boolean) => [
      {
        index: '1',
        path: '/downloads/a',
        length: '1',
        completedLength: '0',
        selected: String(selected),
        uris: [],
      },
      {
        index: '2',
        path: '/downloads/b',
        length: '1',
        completedLength: '0',
        selected: 'true',
        uris: [],
      },
    ]
    let finish!: (value: ReturnType<typeof files>) => void
    const oldRead = new Promise<ReturnType<typeof files>>((resolve) => {
      finish = resolve
    })
    let first = true
    protocol.call.mockImplementation(async (method) => {
      if (method === 'taiji.getFiles') {
        if (first) {
          first = false
          return oldRead
        }
        return files(false)
      }
      if (method === 'taiji.tellStatus')
        return { gid: 'gid', status: 'active', downloadSpeed: '10' }
      return 'gid'
    })
    const snapshot = {
      gid: 'gid',
      status: 'paused',
      dir: '/downloads',
      totalLength: '2',
      infoHash: 'hash',
      bittorrent: { info: { name: 'bundle' } },
    }
    const stale = cache.hydrate(snapshot as never)
    await rpc.pause('gid')
    await rpc.confirmTorrentSelection('gid', {
      dir: '/downloads',
      'select-file': '2',
    })
    finish(files(true))
    expect(await stale).toBeNull()
    expect(
      (await cache.hydrate(snapshot as never))?.fileMetadata.selectedFiles
    ).toEqual([1])
    expect((await rpc.tellStatus('gid')).status).toBe('active')
    expect(protocol.call).toHaveBeenCalledWith(
      'taiji.confirmTorrentSelection',
      ['token:secret', 'gid', { dir: '/downloads', 'select-file': '2' }],
      undefined
    )
  })

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
      schemaVersion: 1,
      rpcExtensions: ['taiji.moveStorage'],
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

  it('rejects malformed or mismatched native capability reports', async () => {
    const { rpc, protocol } = fixture()
    const adapter = new TaijiAdapter(rpc)
    protocol.call.mockImplementation(async (method) =>
      method === 'taiji.getVersion'
        ? { version: 'taiji/0.9.0', enabledFeatures: ['BitTorrent'] }
        : {
            schemaVersion: 1,
            version: 'taiji/0.8.0',
            rpcExtensions: ['taiji.moveStorage'],
          }
    )
    await expect(adapter.connect()).rejects.toThrow(
      'Inconsistent taiji identity'
    )
    expect(adapter.getFeatureReport().hasMoveStorage).toBe(false)
    protocol.call.mockResolvedValue({ version: 'taiji/0.9.0' })
    await expect(rpc.getNativeCapabilities()).rejects.toThrow(
      'Invalid native taiji capability'
    )
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

it('keeps a lost rename reply unconfirmed and invalidates cached paths', async () => {
  const { rpc, protocol } = fixture()
  const adapter = new TaijiAdapter(rpc)
  const invalidated = vi.fn()
  const unsubscribe = rpc.onTaskMetadataChanged(invalidated)
  protocol.call.mockRejectedValueOnce(new Error('RPC request timed out'))
  try {
    await expect(
      adapter.renameTaskFile('gid', 0, '/data/old', '/data/new')
    ).rejects.toThrow('task.fileRename.pending')
    expect(protocol.call).toHaveBeenCalledWith(
      'taiji.renameFile',
      ['token:secret', 'gid', '/data/old', '/data/new'],
      undefined
    )
    expect(invalidated).toHaveBeenCalledWith('gid')
  } finally {
    unsubscribe()
    adapter.dispose()
  }
})
