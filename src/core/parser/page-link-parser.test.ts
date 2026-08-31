import type { PageFetchResponse } from '@core/parser/page-link-parser'
import {
  extractPageLinks,
  extractPageLinksFromCandidates,
  PageLinkParser,
} from '@core/parser/page-link-parser'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it, vi } from 'vitest'

function fakeResponse(
  html: string,
  options: { url?: string; ok?: boolean; status?: number } = {}
): PageFetchResponse {
  return {
    url: options.url ?? '',
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: () => null },
    body: null,
    text: async () => html,
  }
}

const PAGE = 'https://example.com/downloads/page'

describe('extractPageLinks', () => {
  it('extracts anchor, media, and script-embedded links matching the whitelist', () => {
    const html = `
      <html><head><title>My Files &amp; Stuff</title></head><body>
        <a href="https://cdn.example.com/movie.mkv">video</a>
        <a href="/files/report.pdf">doc</a>
        <a href="https://mirror.example.com/tool.exe">tool</a>
        <video src="/stream/episode.mp4"></video>
        <img src="https://img.example.com/pic%20name.jpg" />
        <script>
          window.__DATA__ = {"file":"https://cdn.example.com/pack.zip"}
        </script>
      </body></html>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.mkv', '.pdf', '.exe', '.mp4', '.jpg', '.zip']),
    })

    expect(result.title).toBe('My Files & Stuff')
    const byUrl = new Map(result.links.map((l) => [l.url, l]))
    expect(result.links).toHaveLength(6)
    expect(byUrl.get('https://cdn.example.com/movie.mkv')?.filename).toBe(
      'movie.mkv'
    )
    expect(byUrl.get('https://example.com/files/report.pdf')?.filename).toBe(
      'report.pdf'
    )
    expect(byUrl.get('https://mirror.example.com/tool.exe')?.filename).toBe(
      'tool.exe'
    )
    expect(byUrl.get('https://example.com/stream/episode.mp4')?.filename).toBe(
      'episode.mp4'
    )
    expect(byUrl.get('https://cdn.example.com/pack.zip')?.filename).toBe(
      'pack.zip'
    )
    // %20 decoded into the displayed filename.
    expect(byUrl.get('https://img.example.com/pic%20name.jpg')?.filename).toBe(
      'pic name.jpg'
    )
  })

  it('drops links whose extension is not in the whitelist', () => {
    const html = `
      <a href="https://example.com/movie.mkv">movie</a>
      <a href="https://example.com/report.pdf">doc</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.mkv']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/movie.mkv',
    ])
  })

  it('returns no links when the whitelist is empty', () => {
    const html = `<a href="https://example.com/file.zip">f</a>`
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set<string>(),
    })
    expect(result.links).toHaveLength(0)
  })

  it('resolves relative candidates against <base href> and the final URL', () => {
    const html = `
      <base href="https://cdn.example.com/pub/">
      <a href="file.rar">rar</a>
      <a href="https://example.com/other/song.mp3">song</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: 'https://example.com/downloads/redirected',
      html,
      extensionFilter: new Set(['.rar', '.mp3']),
    })
    const urls = result.links.map((l) => l.url)
    expect(urls).toContain('https://cdn.example.com/pub/file.rar')
    expect(urls).toContain('https://example.com/other/song.mp3')
  })

  it('drops navigation pages and non-http links', () => {
    const html = `
      <a href="https://example.com/about">about page</a>
      <a href="https://example.com/data.tar.gz">tarball</a>
      <a href="https://example.com/tool.rar">rar</a>
      <a href="magnet:?xt=urn:btih:abc">magnet</a>
      <a href="ftp://example.com/file.zip">ftp</a>
      <a href="javascript:void(0)">js</a>
      <a href="mailto:a@b.com">mail</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.rar', '.zip']),
    })
    // No extension -> cannot match the whitelist; non-http schemes dropped.
    // Compound extensions are not supported (whitelist is single-dot only),
    // so data.tar.gz lexes as `.gz` and is likewise dropped.
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/tool.rar',
    ])
  })

  it('deduplicates fragment variants of the same resource', () => {
    const html = `
      <a href="https://cdn.example.com/a.zip">one</a>
      <a href="https://cdn.example.com/a.zip#section">two</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.zip']),
    })
    expect(result.links).toHaveLength(1)
  })

  it('sanitizes forbidden filename characters', () => {
    const html = `<a href="https://example.com/files/my%3Afile%20name.mp4">v</a>`
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.mp4']),
    })
    expect(result.links[0]?.filename).toBe('my_file name.mp4')
  })

  it('collects srcset candidates matching the whitelist', () => {
    const html = `<img srcset="/img/low.webp 480w, /img/high.webp 1080w" src="/img/fallback.jpg">`
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.webp', '.jpg']),
    })
    expect(result.links.map((l) => l.url).sort()).toEqual([
      'https://example.com/img/fallback.jpg',
      'https://example.com/img/high.webp',
      'https://example.com/img/low.webp',
    ])
  })

  it('caps the link list at maxLinks', () => {
    const html = Array.from(
      { length: 10 },
      (_, i) => `<a href="/f${i}.zip">f${i}</a>`
    ).join('')
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      maxLinks: 3,
      extensionFilter: new Set(['.zip']),
    })
    expect(result.links).toHaveLength(3)
    expect(result.links.map((l) => l.index)).toEqual([0, 1, 2])
  })

  it('surfaces any extension explicit in the whitelist', () => {
    const html = `
      <a href="https://example.com/os.iso">iso</a>
      <a href="https://example.com/model.gguf">model</a>
      <a href="https://example.com/movie.mkv">movie</a>
      <a href="https://example.com/noext">noext</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.iso', '.gguf']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/os.iso',
      'https://example.com/model.gguf',
    ])
    expect(result.links[1]?.filename).toBe('model.gguf')
  })

  it('whitelists page assets (e.g. .js) when explicitly configured', () => {
    const html = `<a href="https://example.com/app.js">js</a>`
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.js']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/app.js',
    ])
  })

  it('rewrites ModelScope viewer URLs to the resolve download endpoint', () => {
    const html = `
      <a href="https://modelscope.cn/models/Qwen/Qwen3.8-Flash-Next/file/view/master/model-00001-of-00131.safetensors?status=2">f1</a>
      <a href="https://www.modelscope.cn/models/Qwen/Qwen3.8-Flash-Next/file/view/master/model-00002-of-00131.safetensors?status=2">f2</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.safetensors']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://modelscope.cn/models/Qwen/Qwen3.8-Flash-Next/resolve/master/model-00001-of-00131.safetensors',
      'https://www.modelscope.cn/models/Qwen/Qwen3.8-Flash-Next/resolve/master/model-00002-of-00131.safetensors',
    ])
    expect(result.links[0]?.filename).toBe('model-00001-of-00131.safetensors')
  })

  it('rewrites HuggingFace blob URLs to the resolve download endpoint', () => {
    const html = `
      <a href="https://huggingface.co/Qwen/Qwen3-8B/blob/main/model-00001-of-00002.safetensors">f1</a>
      <a href="https://hf-mirror.com/Qwen/Qwen3-8B/blob/main/model-00002-of-00002.safetensors">f2</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.safetensors']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://huggingface.co/Qwen/Qwen3-8B/resolve/main/model-00001-of-00002.safetensors',
      'https://hf-mirror.com/Qwen/Qwen3-8B/resolve/main/model-00002-of-00002.safetensors',
    ])
  })

  it('leaves non-viewer URLs untouched on rewrite hosts', () => {
    const html = `<a href="https://modelscope.cn/api/v1/models/Qwen/Qwen3.8-Flash-Next/repo/model.safetensors">f</a>`
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.safetensors']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://modelscope.cn/api/v1/models/Qwen/Qwen3.8-Flash-Next/repo/model.safetensors',
    ])
  })

  it('drops script/link chrome assets even when their extension is whitelisted', () => {
    // Regression: ModelScope ships its FE manifest as a script whose URL
    // ends in .json; with .json whitelisted it masqueraded as the only
    // "file" on the page. Script/link sources never enter the candidates.
    const html = `
      <script src="//lang.alicdn.com/mcms/modelscope-fe/0.0.238/modelscope-fe.json" crossorigin="anonymous"></script>
      <link rel="icon" href="/favicon.ico">
      <a href="https://modelscope.cn/models/o/m/file/view/master/model.safetensors?status=2">f</a>
    `
    const result = extractPageLinks({
      pageUrl: PAGE,
      finalUrl: PAGE,
      html,
      extensionFilter: new Set(['.json', '.safetensors']),
    })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://modelscope.cn/models/o/m/resolve/master/model.safetensors',
    ])
  })
})

describe('extractPageLinksFromCandidates', () => {
  it('runs the shared pipeline over explicit candidates', () => {
    const result = extractPageLinksFromCandidates({
      pageUrl: PAGE,
      finalUrl: 'https://modelscope.cn/models/o/m/files',
      title: 'Files',
      candidates: [
        'https://modelscope.cn/models/o/m/file/view/master/model.safetensors?status=2',
        'https://modelscope.cn/models/o/m/file/view/master/model.safetensors?status=2',
        'relative/config.json',
      ],
      extensionFilter: new Set(['.safetensors', '.json']),
    })

    expect(result.title).toBe('Files')
    expect(result.finalUrl).toBe('https://modelscope.cn/models/o/m/files')
    expect(result.links.map((l) => l.url)).toEqual([
      'https://modelscope.cn/models/o/m/resolve/master/model.safetensors',
      'https://modelscope.cn/models/o/m/relative/config.json',
    ])
  })

  it('defaults the title to null and resolves against the final URL', () => {
    const result = extractPageLinksFromCandidates({
      pageUrl: PAGE,
      finalUrl: 'https://example.com/downloads/',
      candidates: ['a.zip'],
      extensionFilter: new Set(['.zip']),
    })
    expect(result.title).toBeNull()
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/downloads/a.zip',
    ])
  })
})

describe('PageLinkParser.parse', () => {
  it('rejects invalid payloads with IpcInvalidPayload', async () => {
    const parser = new PageLinkParser()
    await expect(parser.parse({ url: 42 })).rejects.toMatchObject({
      code: ErrorCode.IpcInvalidPayload,
    })
  })

  it('rejects non-http(s) page URLs', async () => {
    const parser = new PageLinkParser()
    await expect(
      parser.parse({ url: 'ftp://example.com/' })
    ).rejects.toMatchObject({ code: ErrorCode.PageParseFailed })
  })

  it('surfaces non-2xx responses as PageParseFailed', async () => {
    const parser = new PageLinkParser({
      fetch: async () => fakeResponse('', { ok: false, status: 404 }),
    })
    await expect(parser.parse({ url: PAGE })).rejects.toMatchObject({
      code: ErrorCode.PageParseFailed,
    })
  })

  it('wraps fetch failures as PageParseFailed', async () => {
    const parser = new PageLinkParser({
      fetch: async () => {
        throw new Error('boom')
      },
    })
    await expect(parser.parse({ url: PAGE })).rejects.toMatchObject({
      code: ErrorCode.PageParseFailed,
    })
  })

  it('injects a default User-Agent and passes user headers through', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      fakeResponse('<a href="https://cdn.example.com/a.zip">a</a>', {
        url: 'https://example.com/final',
      })
    )
    const parser = new PageLinkParser({
      fetch: fetchMock,
      extensionFilter: new Set(['.zip']),
    })
    const result = await parser.parse({
      url: PAGE,
      headers: [{ name: 'Cookie', value: 'sid=1' }],
    })

    const init = fetchMock.mock.calls[0]?.[1]
    const headers = init?.headers as Headers
    expect(headers.get('cookie')).toBe('sid=1')
    expect(headers.get('user-agent')).toMatch(/^Mozilla\/5\.0/)

    expect(result.pageUrl).toBe(PAGE)
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(result.links).toHaveLength(1)
  })

  it('truncates oversized bodies but keeps the parsed prefix', async () => {
    const chunk1 = new TextEncoder().encode('<a href="/a.zip">a</a>')
    const chunk2 = new TextEncoder().encode('<a href="/b.zip">b</a>')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1)
        controller.enqueue(chunk2)
        controller.close()
      },
    })
    const response: PageFetchResponse = {
      url: '',
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: stream,
      text: async () => {
        throw new Error('text() should not be used when body is present')
      },
    }
    const parser = new PageLinkParser({
      fetch: async () => response,
      maxBodyBytes: chunk1.byteLength,
      extensionFilter: new Set(['.zip']),
    })
    const result = await parser.parse({ url: PAGE })
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/a.zip',
    ])
  })
})