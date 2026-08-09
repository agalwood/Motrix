import type { DownloadAddParams } from '@motrix/mdxp'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import { describe, expect, it, vi } from 'vitest'
import { buildCreateRequest } from './download-add-to-create-request'

// A parser stub that should never be consulted unless select-all kicks in.
const neverParse = vi.fn(async () => {
  throw new Error('parseTorrentFileCount should not be called')
})

describe('buildCreateRequest — url', () => {
  it('maps a url submit onto a native http request', async () => {
    const params: DownloadAddParams = {
      kind: 'url',
      saveDir: '/dl',
      uris: ['https://example.com/f.iso'],
      filename: 'f.iso',
      connections: 8,
      headers: [{ name: 'Referer', value: 'https://example.com' }],
      proxy: 'http://127.0.0.1:8888',
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).toMatchObject({
      type: 'http',
      uris: ['https://example.com/f.iso'],
      saveDir: '/dl',
      filename: 'f.iso',
      connections: 8,
      headers: [{ name: 'Referer', value: 'https://example.com' }],
      proxy: 'http://127.0.0.1:8888',
    })
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })

  it('defaults headers to [] when absent', async () => {
    const params: DownloadAddParams = {
      kind: 'url',
      saveDir: '/dl',
      uris: ['https://example.com/f.iso'],
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).toMatchObject({ type: 'http', headers: [] })
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })
})

describe('buildCreateRequest — magnet', () => {
  it('maps a magnet onto a native bt request, empty selection allowed', async () => {
    const params: DownloadAddParams = {
      kind: 'magnet',
      saveDir: '/dl',
      uri: 'magnet:?xt=urn:btih:abc',
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).toMatchObject({
      type: 'bt',
      saveDir: '/dl',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' },
      selectedFiles: [],
    })
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })

  it('passes an explicit magnet selection through', async () => {
    const params: DownloadAddParams = {
      kind: 'magnet',
      saveDir: '/dl',
      uri: 'magnet:?xt=urn:btih:abc',
      selectedFiles: [0, 2],
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).toMatchObject({ selectedFiles: [0, 2] })
  })
})

describe('buildCreateRequest — torrent', () => {
  it('passes an explicit torrent selection through without parsing', async () => {
    const params: DownloadAddParams = {
      kind: 'torrent',
      saveDir: '/dl',
      base64: 'Zm9v',
      selectedFiles: [1, 3],
      displayName: 'My Torrent',
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).toMatchObject({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: 'Zm9v' },
      selectedFiles: [1, 3],
      displayName: 'My Torrent',
    })
    expect(neverParse).not.toHaveBeenCalled()
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })

  it('drops an empty displayName (public allows "", native requires min 1)', async () => {
    const params: DownloadAddParams = {
      kind: 'torrent',
      saveDir: '/dl',
      base64: 'Zm9v',
      selectedFiles: [0],
      displayName: '',
    }
    const req = await buildCreateRequest(params, neverParse)
    expect(req).not.toHaveProperty('displayName')
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })

  it('resolves an empty torrent selection to select-all (0-based)', async () => {
    const parse = vi.fn(async () => 3)
    const params: DownloadAddParams = {
      kind: 'torrent',
      saveDir: '/dl',
      base64: 'Zm9v',
    }
    const req = await buildCreateRequest(params, parse)
    expect(parse).toHaveBeenCalledWith('Zm9v')
    expect(req).toMatchObject({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: 'Zm9v' },
      selectedFiles: [0, 1, 2],
    })
    // select-all keeps the request valid (torrent-base64 rejects empty selection)
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
  })
})
