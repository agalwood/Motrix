import { describe, expect, it } from 'vitest'
import {
  addTaskFormSchema,
  addTaskUrlParamsSchema,
  encodeUrlParams,
  formValuesToTaskCreateRequest,
  formValuesToTaskCreateRequests,
  taskCreateRequestSchema,
  urlParamsToFormDefaults,
} from './add-task'

describe('addTaskFormSchema', () => {
  it('accepts minimal links tab', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'links',
      urls: 'https://a.com/f.zip',
      saveDir: '/downloads',
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.tab === 'links') {
      expect(result.data.split).toBeUndefined()
    }
  })

  it('rejects links tab with empty urls', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'links',
      urls: '',
      saveDir: '/d',
    })
    expect(result.success).toBe(false)
  })

  it('rejects links tab with empty saveDir', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '',
    })
    expect(result.success).toBe(false)
  })

  it('clamps split range via refine', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '/d',
      split: 200,
    })
    expect(result.success).toBe(false)
  })

  it('accepts torrent tab with source=file + base64', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'torrent',
      source: 'file',
      base64: 'AAAA',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(result.success).toBe(true)
  })

  it('rejects torrent tab with source=file but no base64', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'torrent',
      source: 'file',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(result.success).toBe(false)
  })

  it('rejects torrent tab with empty selectedFiles', () => {
    const result = addTaskFormSchema.safeParse({
      tab: 'torrent',
      source: 'magnet',
      magnetUri: 'magnet:?xt=urn:btih:xxx',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [],
      saveDir: '/d',
    })
    expect(result.success).toBe(false)
  })
})

describe('taskCreateRequestSchema', () => {
  it('accepts minimal http request', () => {
    const result = taskCreateRequestSchema.safeParse({
      type: 'http',
      uris: ['https://a/b'],
      saveDir: '/d',
      headers: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects http request with empty uris', () => {
    const result = taskCreateRequestSchema.safeParse({
      type: 'http',
      uris: [],
      saveDir: '/d',
      headers: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts bt request with magnet payload', () => {
    const result = taskCreateRequestSchema.safeParse({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:xxx' },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(result.success).toBe(true)
  })

  it('accepts bt magnet request without selected files', () => {
    const result = taskCreateRequestSchema.safeParse({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:xxx' },
      selectedFiles: [],
      saveDir: '/d',
    })
    expect(result.success).toBe(true)
  })

  it('rejects bt magnet payload with non-magnet uri', () => {
    const result = taskCreateRequestSchema.safeParse({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'https://x' },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(result.success).toBe(false)
  })
})

describe('formValuesToTaskCreateRequests', () => {
  it('creates one request per link line', () => {
    const reqs = formValuesToTaskCreateRequests({
      tab: 'links',
      urls: 'https://a/b\nhttps://c/d',
      saveDir: '/d',
      split: 5,
    })
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toMatchObject({ type: 'http', uris: ['https://a/b'] })
    expect(reqs[1]).toMatchObject({ type: 'http', uris: ['https://c/d'] })
  })

  it('converts a magnet line into its own bt request', () => {
    const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`
    const reqs = formValuesToTaskCreateRequests({
      tab: 'links',
      urls: `${magnet}\nhttps://c/d`,
      saveDir: '/d',
      split: 5,
    })
    expect(reqs[0]).toMatchObject({
      type: 'bt',
      payload: { kind: 'magnet', uri: magnet },
    })
    expect(reqs[1]).toMatchObject({ type: 'http', uris: ['https://c/d'] })
  })

  it('applies the filename override only for a single line', () => {
    const multi = formValuesToTaskCreateRequests({
      tab: 'links',
      urls: 'https://a/b\nhttps://c/d',
      saveDir: '/d',
      split: 5,
      filename: 'x.zip',
    }) as Array<{ filename?: string }>
    expect(multi.map((r) => r.filename)).toEqual([undefined, undefined])

    const single = formValuesToTaskCreateRequests({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '/d',
      split: 5,
      filename: 'x.zip',
    })
    expect(single[0]).toMatchObject({ filename: 'x.zip' })
  })

  it('wraps a torrent submission in a single request', () => {
    const reqs = formValuesToTaskCreateRequests({
      tab: 'torrent',
      source: 'file',
      base64: 'AAAA',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({ type: 'bt' })
  })
})

describe('formValuesToTaskCreateRequest', () => {
  it('converts minimal links form', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'https://a/b\nhttps://c/d',
      saveDir: '/d',
    })
    expect(req).toEqual({
      type: 'http',
      uris: ['https://a/b', 'https://c/d'],
      saveDir: '/d',
      filename: undefined,
      headers: [],
      proxy: undefined,
    })
    expect(req).not.toHaveProperty('connections')
  })

  it('uses connections only when the task override is explicit', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '/d',
      split: 5,
    })

    expect(req).toMatchObject({ type: 'http', connections: 5 })
  })

  it('drops empty url lines', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'https://a/b\n\n  \nhttps://c/d',
      saveDir: '/d',
      split: 5,
    }) as Extract<
      ReturnType<typeof formValuesToTaskCreateRequest>,
      { type: 'http' }
    >
    expect(req.uris).toEqual(['https://a/b', 'https://c/d'])
  })

  it('builds headers from userAgent/referer/cookie/authorization', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '/d',
      split: 5,
      userAgent: 'Mozilla/5.0',
      referer: 'https://ref',
      cookie: 'k=v',
      authorization: 'Bearer x',
    }) as Extract<
      ReturnType<typeof formValuesToTaskCreateRequest>,
      { type: 'http' }
    >
    expect(req.headers).toEqual([
      { name: 'User-Agent', value: 'Mozilla/5.0' },
      { name: 'Referer', value: 'https://ref' },
      { name: 'Cookie', value: 'k=v' },
      { name: 'Authorization', value: 'Bearer x' },
    ])
  })

  it('empty header values are skipped', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'https://a/b',
      saveDir: '/d',
      split: 5,
      userAgent: '   ',
    }) as Extract<
      ReturnType<typeof formValuesToTaskCreateRequest>,
      { type: 'http' }
    >
    expect(req.headers).toEqual([])
  })

  it('converts torrent file form', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'torrent',
      source: 'file',
      base64: 'AAAA',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [0, 2],
      saveDir: '/d',
    })
    expect(req).toEqual({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: 'AAAA' },
      selectedFiles: [0, 2],
      saveDir: '/d',
      dlLimit: undefined,
      ulLimit: undefined,
      seedRatio: undefined,
    })
  })

  it('converts magnet form', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'torrent',
      source: 'magnet',
      magnetUri: 'magnet:?xt=urn:btih:xxx',
      torrentMeta: {
        name: 't',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [],
      },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(req).toEqual({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:xxx' },
      selectedFiles: [0],
      saveDir: '/d',
      dlLimit: undefined,
      ulLimit: undefined,
      seedRatio: undefined,
    })
  })

  it('converts resolved magnet metadata form into a torrent-base64 request', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'torrent',
      source: 'magnet',
      magnetUri: 'magnet:?xt=urn:btih:xxx',
      base64: 'dG9ycmVudA==',
      torrentMeta: {
        name: 'resolved-root',
        infoHash: 'a'.repeat(40),
        totalSize: 1,
        files: [
          { index: 0, path: 'resolved-root/a.txt', size: 1, extension: '.txt' },
        ],
      },
      selectedFiles: [0],
      saveDir: '/d',
    })
    expect(req).toEqual({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: 'dG9ycmVudA==' },
      selectedFiles: [0],
      saveDir: '/d',
      dlLimit: undefined,
      ulLimit: undefined,
      seedRatio: undefined,
      displayName: 'resolved-root',
    })
  })

  it('converts a links-tab magnet into a magnet task request', () => {
    const req = formValuesToTaskCreateRequest({
      tab: 'links',
      urls: 'magnet:?xt=urn:btih:xxx',
      saveDir: '/d',
      split: 5,
    })
    expect(req).toEqual({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:xxx' },
      selectedFiles: [],
      saveDir: '/d',
      dlLimit: undefined,
      ulLimit: undefined,
      seedRatio: undefined,
    })
  })
})

describe('addTaskUrlParamsSchema', () => {
  it('accepts empty object (defaults mode to links)', () => {
    const result = addTaskUrlParamsSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.mode).toBe('links')
  })

  it('rejects magnet field with non-magnet value', () => {
    const result = addTaskUrlParamsSchema.safeParse({ magnet: 'https://x' })
    expect(result.success).toBe(false)
  })

  it('accepts userAgent/referer/cookie passthrough', () => {
    const result = addTaskUrlParamsSchema.safeParse({
      userAgent: 'UA',
      referer: 'R',
      cookie: 'C',
    })
    expect(result.success).toBe(true)
  })
})

describe('urlParamsToFormDefaults', () => {
  it('prefills magnet links into the links textarea', () => {
    const d = urlParamsToFormDefaults({
      mode: 'torrent',
      magnet: 'magnet:?xt=urn:btih:xxx',
      saveDir: '/d',
    })
    expect(d.tab).toBe('links')
    expect((d as { urls?: string }).urls).toBe('magnet:?xt=urn:btih:xxx')
  })

  it('falls back to links mode with url seed', () => {
    const d = urlParamsToFormDefaults({ mode: 'links', url: 'https://a/b' })
    expect(d.tab).toBe('links')
    expect((d as { urls?: string }).urls).toBe('https://a/b')
  })
})

describe('encodeUrlParams', () => {
  it('stringifies non-empty fields only', () => {
    const encoded = encodeUrlParams({
      mode: 'torrent',
      magnet: 'magnet:?x',
      saveDir: undefined,
    })
    expect(encoded).toEqual({ mode: 'torrent', magnet: 'magnet:?x' })
  })
})
