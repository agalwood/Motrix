// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LegacyProxyOptions } from '@core/engine/engine-adapter'
import type { LegacyBtRequestSource } from '@shared/schemas/legacy-bt-request'
import { describe, expect, it, vi } from 'vitest'
import { Aria2Adapter } from './aria2-adapter'
import { legacyProxyMatches, legacyProxyOptions } from './aria2-legacy-proxy'
import type { Aria2RpcClient } from './aria2-rpc-client'

const context: LegacyProxyOptions = {
  allProxy: 'http://old%40user:raw%2540secret@old.example:3128/',
  httpProxy: 'http://http.example:8080/',
  httpsProxy: '',
  ftpProxy: '',
  noProxy: '.internal,127.0.0.1',
  proxyMethod: 'tunnel',
}
const reference: LegacyBtRequestSource = {
  version: 1,
  runId: '12345678-1234-4234-8234-123456789012',
  itemKey: 'gid:1234567890abcdef',
  snapshotDigest: 'a'.repeat(64),
  manifestDigest: 'b'.repeat(64),
  infoHash: '45c7c651e500cc0ceaa544d6fbafcb21b8cd52f8',
  torrentDigest: 'c'.repeat(64),
}
const gid = '1234567890abcdef'
const magnet = `magnet:?xt=urn:btih:${reference.infoHash}`

function fixture() {
  const rpc = {
    addUri: vi.fn(async (..._args: unknown[]) => gid),
    addTorrent: vi.fn(async (..._args: unknown[]) => gid),
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  }
  const adapter = new Aria2Adapter(rpc as unknown as Aria2RpcClient)
  const resolver = vi.fn(async () => context)
  return { rpc, adapter, resolver }
}

describe('legacy BT proxy isolation', () => {
  it('pins every route and credential, including empty overrides', () => {
    const options = legacyProxyOptions(context)
    expect(options).toEqual({
      'all-proxy': 'http://old.example:3128/',
      'all-proxy-user': 'old@user',
      'all-proxy-passwd': 'raw%40secret',
      'http-proxy': 'http://http.example:8080/',
      'http-proxy-user': '',
      'http-proxy-passwd': '',
      'https-proxy': '',
      'https-proxy-user': '',
      'https-proxy-passwd': '',
      'ftp-proxy': '',
      'ftp-proxy-user': '',
      'ftp-proxy-passwd': '',
      'no-proxy': context.noProxy,
      'proxy-method': 'tunnel',
    })
    expect(legacyProxyMatches(options, context)).toBe(true)
    for (const key of Object.keys(options))
      expect(
        legacyProxyMatches({ ...options, [key]: 'changed' }, context)
      ).toBe(false)
  })

  it.each([
    'socks5://proxy.example:1080',
    'http://user:%0asecret@proxy.example',
  ])('rejects unsupported proxy input %s without dispatch', (allProxy) => {
    expect(() => legacyProxyOptions({ ...context, allProxy })).toThrow(
      'Invalid legacy proxy'
    )
  })

  it('resolves the original magnet context at dispatch and pins it after tracker policy', async () => {
    const f = fixture()
    f.adapter.setLegacyBtRequestResolver(f.resolver)
    await f.adapter.createDownload({
      uris: [magnet],
      saveDir: '/downloads',
      legacyBtRequestSource: reference,
    })
    expect(f.resolver).toHaveBeenCalledWith(reference, reference.infoHash)
    expect(f.rpc.addUri.mock.calls[0]?.[1]).toMatchObject(
      legacyProxyOptions(context)
    )
  })

  it('resolves the same reference for the torrent payload rather than using current globals', async () => {
    const f = fixture()
    f.adapter.setLegacyBtRequestResolver(f.resolver)
    const metadata = await readFile(
      path.resolve(
        'tests/fixtures/legacy-v1/generated/downloads/a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent'
      )
    )
    await f.adapter.addTorrent({
      metadata,
      saveDir: '/downloads',
      legacyBtRequestSource: reference,
    })
    expect(f.resolver).toHaveBeenCalledWith(reference, reference.infoHash)
    expect(f.rpc.addTorrent.mock.calls[0]?.[2]).toMatchObject(
      legacyProxyOptions(context)
    )
  })

  it('fails closed for unavailable or changed references and rejects the extra-options bypass', async () => {
    const f = fixture()
    const params = {
      uris: [magnet],
      saveDir: '/downloads',
      legacyBtRequestSource: reference,
    }
    await expect(f.adapter.createDownload(params)).rejects.toThrow(
      'Invalid legacy BT request context'
    )
    f.adapter.setLegacyBtRequestResolver(async () => {
      throw new Error('Changed legacy source')
    })
    await expect(f.adapter.createDownload(params)).rejects.toThrow(
      'Changed legacy source'
    )
    await expect(
      f.adapter.createDownload({
        ...params,
        extraEngineOptions: { 'http-proxy': 'http://other.example' },
      })
    ).rejects.toThrow('Reserved aria2 proxy option')
    expect(f.rpc.addUri).not.toHaveBeenCalled()
  })

  it('leaves ordinary magnet creation on the existing routing policy', async () => {
    const f = fixture()
    f.adapter.setLegacyBtRequestResolver(f.resolver)
    await f.adapter.createDownload({ uris: [magnet], saveDir: '/downloads' })
    expect(f.resolver).not.toHaveBeenCalled()
    expect(f.rpc.addUri.mock.calls[0]?.[1]).not.toHaveProperty('all-proxy')
  })
})
