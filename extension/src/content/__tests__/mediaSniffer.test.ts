import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectFromUrls, installSniffer } from '@/content/mediaSniffer'
import type { DetectedMedia } from '@/shared/media'

const ctx = {
  pageUrl: 'https://site/p',
  pageTitle: 'P',
  now: 100,
  webStore: false,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

describe('collectFromUrls', () => {
  it('classifies, dedups, and drops non-media', () => {
    const out = collectFromUrls(
      [
        { url: 'https://cdn/a/master.m3u8' },
        { url: 'https://cdn/a/master.m3u8' }, // dup
        { url: 'https://cdn/a/page.html' }, // non-media
        { url: 'https://cdn/a/v.mpd' },
      ],
      ctx
    )
    expect(out.map((m) => m.kind)).toEqual(['hls', 'dash'])
    expect(out[0]?.pageTitle).toBe('P')
  })

  it('drops youtube hosts in web-store build', () => {
    const out = collectFromUrls(
      [
        { url: 'https://r1.googlevideo.com/videoplayback?x=1' },
        { url: 'https://cdn/a/v.m3u8' },
      ],
      { ...ctx, webStore: true }
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.url).toContain('cdn')
  })

  it('resolves relative network URLs against the current page', () => {
    const out = collectFromUrls([{ url: '/media/master.m3u8' }], ctx)
    expect(out[0]?.url).toBe('https://site/media/master.m3u8')
  })

  it('classifies audio and image resources with MIME values used by filters', () => {
    const out = collectFromUrls(
      [
        { url: '/media/theme.mp3' },
        { url: '/images/cover.webp' },
        { url: '/asset?id=hero', contentType: 'image/avif' },
      ],
      ctx
    )

    expect(out).toMatchObject([
      {
        kind: 'direct',
        url: 'https://site/media/theme.mp3',
        mimeType: 'audio/mpeg',
      },
      {
        kind: 'direct',
        url: 'https://site/images/cover.webp',
        mimeType: 'image/webp',
      },
      {
        kind: 'direct',
        url: 'https://site/asset?id=hero',
        mimeType: 'image/avif',
      },
    ])
  })

  it('keeps only submit-safe HTTP(S) resources and disables SVG preview', () => {
    const out = collectFromUrls(
      [
        { url: 'data:image/png;base64,AAAA', contentType: 'image/png' },
        { url: 'blob:https://site/id', contentType: 'audio/mpeg' },
        { url: 'ftp://cdn.example/track.mp3' },
        { url: 'https://cdn.example/vector.svg', contentType: 'image/svg+xml' },
        { url: 'https://cdn.example/track.mp3' },
      ],
      ctx
    )

    expect(out.map((item) => item.url)).toEqual([
      'https://cdn.example/vector.svg',
      'https://cdn.example/track.mp3',
    ])
    expect(out[0]).toMatchObject({
      category: 'image',
      mimeType: 'image/svg+xml',
      previewable: false,
    })
  })

  it('reports rich metadata, merges evidence, strips fragments, and filters decorative images', () => {
    const out = collectFromUrls(
      [
        {
          url: 'https://cdn.example/hero.webp#responsive',
          category: 'image',
          width: 1280,
          height: 720,
          alt: '  Hero\u0000 image  ',
          evidence: ['img', 'current-src'],
        },
        {
          url: 'https://cdn.example/hero.webp',
          contentType: 'image/webp',
          evidence: ['srcset'],
        },
        {
          url: 'https://cdn.example/tracker.gif',
          width: 1,
          height: 1,
          evidence: ['img'],
        },
        { url: 'https://cdn.example/chunk-42.m4s', evidence: ['fetch'] },
      ],
      ctx
    )

    expect(out).toEqual([
      {
        kind: 'direct',
        url: 'https://cdn.example/hero.webp',
        pageUrl: 'https://site/p',
        pageTitle: 'P',
        detectedAt: 100,
        category: 'image',
        mimeType: 'image/webp',
        width: 1280,
        height: 720,
        alt: 'Hero  image',
        previewable: true,
        evidence: ['img', 'current-src', 'srcset'],
      },
    ])
  })
})

describe('installSniffer initial harvest (already-loaded media)', () => {
  it('harvests loaded audio, img, picture sources, srcset, and currentSrc', () => {
    document.body.innerHTML = `
      <audio src="/audio/theme.mp3">
        <source src="/audio/theme.ogg" type="audio/ogg">
      </audio>
      <picture>
        <source
          srcset="/images/hero.avif 1x, /images/hero@2x.avif 2x"
          type="image/avif"
        >
        <img
          src="/images/fallback.jpg"
          srcset="/images/small.webp 480w, /images/large.webp 960w"
          alt=""
        >
      </picture>
    `
    const image = document.querySelector('img')
    expect(image).not.toBeNull()
    Object.defineProperty(image, 'currentSrc', {
      configurable: true,
      value: 'https://cdn.example/selected.webp',
    })
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 960 },
      naturalHeight: { configurable: true, value: 540 },
    })
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([] as unknown as PerformanceEntryList)
    const reported: DetectedMedia[][] = []

    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/gallery/page',
      pageTitle: 'Gallery',
    })
    sniffer.uninstall()

    const items = reported.flat()
    expect(items.map((item) => item.url)).toEqual([
      'https://site/audio/theme.mp3',
      'https://site/audio/theme.ogg',
      'https://site/images/hero.avif',
      'https://site/images/hero@2x.avif',
      'https://cdn.example/selected.webp',
      'https://site/images/fallback.jpg',
      'https://site/images/small.webp',
      'https://site/images/large.webp',
    ])
    expect(
      items
        .filter((item) => item.mimeType?.startsWith('audio/'))
        .map((item) => item.kind)
    ).toEqual(['direct', 'direct'])
    expect(
      items.filter((item) => item.mimeType?.startsWith('image/'))
    ).toHaveLength(6)
    expect(
      items.find((item) => item.url === 'https://cdn.example/selected.webp')
        ?.evidence
    ).toEqual(['img', 'current-src'])
    expect(
      items.find((item) => item.url === 'https://site/images/small.webp')
    ).toMatchObject({ width: 480, height: 270 })
    expect(
      items.find((item) => item.url === 'https://site/images/large.webp')
    ).toMatchObject({ width: 960, height: 540 })

    document.body.replaceChildren()
    spy.mockRestore()
  })

  it('harvests the manifest from Resource Timing, ignoring segments + non-media', () => {
    const entries = [
      { name: 'https://cdn/a/master.m3u8' },
      { name: 'https://cdn/a/seg1.ts' }, // segment — not classified as media
      { name: 'https://cdn/a/app.js' }, // non-media
      { name: 'https://cdn/a/movie.mp4' }, // direct
    ]
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(entries as unknown as PerformanceEntryList)
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/p',
      pageTitle: 'P',
    })
    sniffer.uninstall()
    const urls = reported.flat().map((m) => m.url)
    expect(urls).toContain('https://cdn/a/master.m3u8')
    expect(urls).toContain('https://cdn/a/movie.mp4')
    expect(urls).not.toContain('https://cdn/a/seg1.ts')
    expect(urls).not.toContain('https://cdn/a/app.js')
    spy.mockRestore()
  })

  it('re-harvests the current route without reinstalling hooks', () => {
    const oldEntry = { name: 'https://cdn/old/master.m3u8' }
    const nextEntry = { name: 'https://cdn/new/master.m3u8' }
    let entries = [oldEntry]
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockImplementation(() => entries as unknown as PerformanceEntryList)

    document.body.innerHTML = '<video src="/old/movie.mp4"></video>'
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/old',
      pageTitle: 'Old route',
    })

    reported.length = 0
    document.body.innerHTML = '<video src="/new/movie.mp4"></video>'
    entries = [oldEntry, nextEntry]
    sniffer.scan({
      pageUrl: 'https://site/new',
      pageTitle: 'New route',
    })
    sniffer.uninstall()

    const rescanned = reported.flat()
    expect(rescanned.map((item) => item.url)).toEqual([
      'https://site/new/movie.mp4',
      'https://cdn/new/master.m3u8',
    ])
    expect(
      rescanned.every(
        (item) =>
          item.pageUrl === 'https://site/new' && item.pageTitle === 'New route'
      )
    ).toBe(true)

    document.body.replaceChildren()
    spy.mockRestore()
  })

  it('re-reports Resource Timing media on an explicit same-page scan', () => {
    const entries = [{ name: 'https://cdn/a/master.m3u8' }]
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(entries as unknown as PerformanceEntryList)
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/p',
      pageTitle: 'P',
    })

    reported.length = 0
    sniffer.scan({ pageUrl: 'https://site/p', pageTitle: 'Updated title' })
    sniffer.uninstall()

    expect(reported.flat()).toMatchObject([
      {
        url: 'https://cdn/a/master.m3u8',
        pageUrl: 'https://site/p',
        pageTitle: 'Updated title',
      },
    ])
    spy.mockRestore()
  })

  it('does not relabel an earlier SPA route during a repeated current-route scan', () => {
    const oldEntry = { name: 'https://cdn/old/master.m3u8' }
    const nextEntry = { name: 'https://cdn/new/master.m3u8' }
    let entries = [oldEntry]
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockImplementation(() => entries as unknown as PerformanceEntryList)
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/old',
      pageTitle: 'Old route',
    })

    entries = [oldEntry, nextEntry]
    sniffer.scan({
      pageUrl: 'https://site/new',
      pageTitle: 'New route',
    })
    reported.length = 0
    sniffer.scan({
      pageUrl: 'https://site/new',
      pageTitle: 'New route again',
    })
    sniffer.uninstall()

    expect(reported.flat().map((item) => item.url)).toEqual([
      'https://cdn/new/master.m3u8',
    ])
    expect(reported.flat()[0]?.pageUrl).toBe('https://site/new')
    spy.mockRestore()
  })

  it('covers lazy, poster, metadata, link, input image, CSS, and pseudo-element sources', () => {
    document.head.innerHTML = `
      <meta property="og:image" content="https://cdn.example/social.webp">
      <link rel="preload" as="audio" href="https://cdn.example/theme.mp3">
    `
    document.body.innerHTML = `
      <img data-src="https://cdn.example/lazy.jpg" alt="Lazy hero" width="800" height="600">
      <video poster="https://cdn.example/poster.jpg" width="1280" height="720"></video>
      <input type="image" src="https://cdn.example/button.png" alt="Submit art" width="160" height="80">
      <section data-flickity-lazyload="https://cdn.example/flickity.webp"></section>
      <section data-background-image="url(https://cdn.example/data-background.jpg)"></section>
      <div id="css-hero"></div>
    `
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudoElt) =>
        ({
          backgroundImage:
            (element as Element).id === 'css-hero' && !pseudoElt
              ? 'url("https://cdn.example/background.avif")'
              : 'none',
          content:
            (element as Element).id === 'css-hero' && pseudoElt === '::before'
              ? 'url(https://cdn.example/badge.webp)'
              : 'none',
        }) as CSSStyleDeclaration
    )
    const reported: DetectedMedia[][] = []

    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/gallery',
      pageTitle: 'Gallery',
    })
    sniffer.uninstall()

    const byUrl = new Map(reported.flat().map((item) => [item.url, item]))
    expect([...byUrl.keys()]).toEqual(
      expect.arrayContaining([
        'https://cdn.example/lazy.jpg',
        'https://cdn.example/poster.jpg',
        'https://cdn.example/social.webp',
        'https://cdn.example/theme.mp3',
        'https://cdn.example/button.png',
        'https://cdn.example/flickity.webp',
        'https://cdn.example/data-background.jpg',
        'https://cdn.example/background.avif',
        'https://cdn.example/badge.webp',
      ])
    )
    expect(byUrl.get('https://cdn.example/lazy.jpg')).toMatchObject({
      category: 'image',
      width: 800,
      height: 600,
      alt: 'Lazy hero',
      evidence: ['img', 'lazy'],
    })
    expect(byUrl.get('https://cdn.example/poster.jpg')?.evidence).toEqual([
      'video',
      'poster',
    ])
    expect(byUrl.get('https://cdn.example/background.avif')?.evidence).toEqual([
      'css-background',
    ])
    expect(byUrl.get('https://cdn.example/badge.webp')?.evidence).toEqual([
      'css-pseudo',
    ])
    expect(byUrl.get('https://cdn.example/flickity.webp')?.evidence).toEqual([
      'lazy',
    ])
  })

  it('batches DOM mutation reports and caps every runtime report at 100 items', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/gallery',
      pageTitle: 'Gallery',
    })

    for (let index = 0; index < 205; index += 1) {
      const image = document.createElement('img')
      image.src = `https://cdn.example/gallery/${index}.jpg`
      document.body.append(image)
    }
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120)
    sniffer.uninstall()

    expect(reported.flat()).toHaveLength(205)
    expect(reported.every((items) => items.length <= 100)).toBe(true)
    expect(reported).toHaveLength(3)
  })

  it('observes common lazy-image attributes added after page startup', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    const target = document.createElement('div')
    document.body.append(target)
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/gallery',
      pageTitle: 'Gallery',
    })
    reported.length = 0

    target.setAttribute(
      'data-splide-lazy',
      'https://cdn.example/dynamic-lazy.avif'
    )
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120)
    sniffer.uninstall()

    expect(reported.flat()).toMatchObject([
      {
        url: 'https://cdn.example/dynamic-lazy.avif',
        evidence: ['lazy'],
      },
    ])
  })

  it('streams new Resource Timing entries through PerformanceObserver', () => {
    type ObserverCallback = ConstructorParameters<typeof PerformanceObserver>[0]
    let callback: ObserverCallback | undefined
    const disconnect = vi.fn()
    class TestPerformanceObserver {
      constructor(next: ObserverCallback) {
        callback = next
      }
      observe() {}
      disconnect = disconnect
      takeRecords(): PerformanceEntryList {
        return []
      }
    }
    vi.stubGlobal(
      'PerformanceObserver',
      TestPerformanceObserver as unknown as typeof PerformanceObserver
    )
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/watch',
      pageTitle: 'Watch',
    })

    callback?.(
      {
        getEntries: () => [
          {
            name: 'https://cdn.example/live/master.m3u8',
            startTime: 1,
            duration: 2,
            initiatorType: 'fetch',
            decodedBodySize: 4096,
          } as PerformanceResourceTiming,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    )
    sniffer.uninstall()

    expect(reported.flat()).toMatchObject([
      {
        kind: 'hls',
        url: 'https://cdn.example/live/master.m3u8',
        sizeBytes: 4096,
        evidence: ['performance'],
      },
    ])
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('inspects fetch and XHR JSON bodies without replacing their responses', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [] as unknown as PerformanceEntryList
    )
    const originalFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ video: 'https://cdn.example/from-fetch.mp4' }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    window.fetch = originalFetch

    class TestXhr extends EventTarget {
      responseURL = 'https://api.example/xhr'
      responseType: XMLHttpRequestResponseType = ''
      responseText = JSON.stringify({
        audio: 'https://cdn.example/from-xhr.mp3',
      })
      open() {}
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null
      }
    }
    vi.stubGlobal('XMLHttpRequest', TestXhr as unknown as typeof XMLHttpRequest)
    const reported: DetectedMedia[][] = []
    const sniffer = installSniffer((items) => reported.push(items), {
      pageUrl: 'https://site/watch',
      pageTitle: 'Watch',
    })

    const response = await window.fetch('https://api.example/fetch')
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://api.example/xhr')
    xhr.dispatchEvent(new Event('load'))
    await vi.waitFor(() => {
      expect(reported.flat().map((item) => item.url)).toEqual(
        expect.arrayContaining([
          'https://cdn.example/from-fetch.mp4',
          'https://cdn.example/from-xhr.mp3',
        ])
      )
    })
    await expect(response.json()).resolves.toEqual({
      video: 'https://cdn.example/from-fetch.mp4',
    })
    sniffer.uninstall()

    expect(originalFetch).toHaveBeenCalledOnce()
    expect(
      reported.flat().find((item) => item.url.endsWith('from-fetch.mp4'))
        ?.evidence
    ).toEqual(['body-json', 'fetch'])
    expect(
      reported.flat().find((item) => item.url.endsWith('from-xhr.mp3'))
        ?.evidence
    ).toEqual(['body-json', 'xhr'])
  })
})
