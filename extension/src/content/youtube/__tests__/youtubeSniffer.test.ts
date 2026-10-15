import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installYoutubeSniffer } from '@/content/youtube/youtubeSniffer'
import type { DetectedMedia } from '@/shared/media'

// Real-shaped googlevideo URLs carrying specific itags.
// itag 137 = video-only (1080p), itag 140 = audio-only (m4a 128k).
const VIDEO_URL =
  'https://r1.googlevideo.com/videoplayback?expire=9999&itag=137&source=youtube'
const AUDIO_URL =
  'https://r1.googlevideo.com/videoplayback?expire=9999&itag=140&source=youtube'

// A minimal ytInitialPlayerResponse whose adaptiveFormats contain one video
// and one audio format, shaping the fields that playerResponseToItagInfo reads.
const PLAYER_RESPONSE = {
  streamingData: {
    adaptiveFormats: [
      {
        itag: 137,
        mimeType: 'video/mp4; codecs="avc1.640028"',
        height: 1080,
        bitrate: 4_000_000,
      },
      {
        itag: 140,
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
      },
    ],
  },
}

const PAGE_CTX = {
  pageUrl: 'https://www.youtube.com/watch?v=test',
  pageTitle: 'Test Video',
}

describe('installYoutubeSniffer', () => {
  let performanceSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Provide the player response so playerResponseToItagInfo can classify itags.
    ;(window as unknown as Record<string, unknown>).ytInitialPlayerResponse =
      PLAYER_RESPONSE
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)
      .ytInitialPlayerResponse
    performanceSpy?.mockRestore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('I-3: emits exactly once even when the same video+audio pair appears multiple times in Resource Timing', () => {
    // Return VIDEO_URL and AUDIO_URL multiple times — 3 video entries + 2 audio entries,
    // plus a duplicate pair — so tryEmit fires on each observe call.
    const entries = [
      { name: VIDEO_URL },
      { name: AUDIO_URL },
      // repeat the same pair — would cause a second report without the dedup fix
      { name: VIDEO_URL },
      { name: AUDIO_URL },
      // a third video entry to confirm selectMuxStreams still picks the right one
      { name: VIDEO_URL },
    ]

    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(entries as unknown as PerformanceEntryList)

    const reported: DetectedMedia[] = []
    const sniffer = installYoutubeSniffer((m) => reported.push(m), PAGE_CTX)

    // Core assertion: exactly one emission despite the pair being observed 2+ times.
    expect(reported).toHaveLength(1)

    const item = reported[0]
    expect(item?.kind).toBe('mux')
    // url = video stream, audioUrl = audio stream
    expect(item?.url).toBe(VIDEO_URL)
    expect(item?.audioUrl).toBe(AUDIO_URL)
    expect(item?.pageUrl).toBe(PAGE_CTX.pageUrl)
    expect(item?.pageTitle).toBe(PAGE_CTX.pageTitle)
    sniffer.uninstall()
  })

  it('I-3: emits once for a pair even without itagInfo (fallback YT_ITAG_KIND table)', () => {
    // Remove the player response so the fallback built-in table is used.
    delete (window as unknown as Record<string, unknown>)
      .ytInitialPlayerResponse

    const entries = [
      { name: VIDEO_URL }, // itag 137 → 'video' in YT_ITAG_KIND
      { name: AUDIO_URL }, // itag 140 → 'audio' in YT_ITAG_KIND
      { name: VIDEO_URL }, // duplicate
      { name: AUDIO_URL }, // duplicate
    ]

    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(entries as unknown as PerformanceEntryList)

    const reported: DetectedMedia[] = []
    const sniffer = installYoutubeSniffer((m) => reported.push(m), PAGE_CTX)

    expect(reported).toHaveLength(1)
    expect(reported[0]?.kind).toBe('mux')
    sniffer.uninstall()
  })

  it('re-harvests only new Resource Timing entries after SPA navigation', () => {
    const oldVideo = { name: VIDEO_URL }
    const oldAudio = { name: AUDIO_URL }
    const nextVideo = { name: `${VIDEO_URL}&route=next` }
    const nextAudio = { name: `${AUDIO_URL}&route=next` }
    let entries = [oldVideo, oldAudio]
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockImplementation(() => entries as unknown as PerformanceEntryList)

    const reported: DetectedMedia[] = []
    const sniffer = installYoutubeSniffer(
      (item) => reported.push(item),
      PAGE_CTX
    )

    reported.length = 0
    entries = [oldVideo, oldAudio, nextVideo, nextAudio]
    sniffer.scan({
      pageUrl: 'https://www.youtube.com/watch?v=next',
      pageTitle: 'Next Video',
    })
    sniffer.uninstall()

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      url: nextVideo.name,
      audioUrl: nextAudio.name,
      pageUrl: 'https://www.youtube.com/watch?v=next',
      pageTitle: 'Next Video',
    })
  })

  it('does not rebuild a mux from an earlier route on a repeated current-route scan', () => {
    const oldVideo = { name: VIDEO_URL }
    const oldAudio = { name: AUDIO_URL }
    const nextVideo = { name: `${VIDEO_URL}&route=next` }
    const nextAudio = { name: `${AUDIO_URL}&route=next` }
    let entries = [oldVideo, oldAudio]
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockImplementation(() => entries as unknown as PerformanceEntryList)
    const reported: DetectedMedia[] = []
    const sniffer = installYoutubeSniffer(
      (item) => reported.push(item),
      PAGE_CTX
    )

    entries = [oldVideo, oldAudio, nextVideo, nextAudio]
    const nextPage = {
      pageUrl: 'https://www.youtube.com/watch?v=next',
      pageTitle: 'Next Video',
    }
    sniffer.scan(nextPage)
    reported.length = 0
    sniffer.scan(nextPage)
    sniffer.uninstall()

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      url: nextVideo.name,
      audioUrl: nextAudio.name,
      pageUrl: nextPage.pageUrl,
    })
  })

  it('bounds all long-lived caches across 5k range requests and repeated SPA scans', () => {
    delete (window as unknown as Record<string, unknown>)
      .ytInitialPlayerResponse
    let entries = Array.from({ length: 5_000 }, (_, index) => ({
      name: `https://r1.googlevideo.com/videoplayback?itag=${1_000 + index}&range=${index}-${index + 1}`,
      startTime: index,
      duration: 1,
      initiatorType: 'fetch',
    }))
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockImplementation(() => entries as unknown as PerformanceEntryList)
    let reportCount = 0
    const sniffer = installYoutubeSniffer(() => {
      reportCount += 1
    }, PAGE_CTX)

    expect(sniffer.cacheSizes()).toEqual({
      observed: 256,
      reported: 0,
      resourcePages: 4_096,
    })

    entries = Array.from({ length: 5_000 }, (_, index) => ({
      name: `https://r2.googlevideo.com/videoplayback?itag=${index % 2 === 0 ? 137 : 140}&range=${index}-${index + 1}`,
      startTime: 10_000 + index,
      duration: 1,
      initiatorType: 'fetch',
    }))
    sniffer.scan(PAGE_CTX)

    expect(reportCount).toBeGreaterThan(256)
    expect(sniffer.cacheSizes()).toEqual({
      observed: 2,
      reported: 256,
      resourcePages: 4_096,
    })
    sniffer.uninstall()
    expect(sniffer.cacheSizes()).toEqual({
      observed: 0,
      reported: 0,
      resourcePages: 0,
    })
  })

  it('accepts only the exact googlevideo.com host or its subdomains', () => {
    const exactVideo =
      'https://GOOGLEVIDEO.COM:443/videoplayback?itag=137&exact=1'
    const subdomainAudio =
      'https://r1.googlevideo.com/videoplayback?itag=140&subdomain=1'
    const entries = [
      {
        get name(): string {
          throw new Error('hostile PerformanceEntry.name getter')
        },
      },
      {
        name: 'https://r1.googlevideo.com.evil.test/videoplayback?itag=137',
      },
      {
        name: 'https://r1.googlevideo.com.evil.test/videoplayback?itag=140',
      },
      {
        name: 'https://googlevideo.com@evil.test/videoplayback?itag=137',
      },
      {
        name: 'https://evil.test/googlevideo.com/videoplayback?itag=140',
      },
      { name: exactVideo },
      { name: subdomainAudio },
    ]
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(entries as unknown as PerformanceEntryList)
    const reported: DetectedMedia[] = []
    const sniffer = installYoutubeSniffer(
      (item) => reported.push(item),
      PAGE_CTX
    )

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      url: exactVideo,
      audioUrl: subdomainAudio,
    })
    sniffer.uninstall()
  })

  it('preserves fetch receiver, Promise identity, and synchronous throw semantics', () => {
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([] as unknown as PerformanceEntryList)
    const previousFetch = window.fetch
    const fetchError = new Error('original fetch failed synchronously')
    const responsePromise = Promise.resolve(new Response('ok'))
    let receiver: unknown
    const originalFetch = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL
    ) {
      receiver = this
      if (input === 'https://page.test/throws') throw fetchError
      return responsePromise
    }) as typeof window.fetch
    window.fetch = originalFetch
    const report = vi.fn(() => {
      throw new Error('relay unavailable')
    })
    const sniffer = installYoutubeSniffer(report, PAGE_CTX)
    const customReceiver = { fetchOwner: true }

    expect(Reflect.apply(window.fetch, customReceiver, [VIDEO_URL])).toBe(
      responsePromise
    )
    expect(receiver).toBe(customReceiver)
    expect(window.fetch(AUDIO_URL)).toBe(responsePromise)
    expect(report).toHaveBeenCalledOnce()
    expect(() => window.fetch('https://page.test/throws')).toThrow(fetchError)

    const hostileInput = {
      get url(): string {
        throw new Error('hostile Request.url getter')
      },
    } as Request
    expect(window.fetch(hostileInput)).toBe(responsePromise)

    sniffer.uninstall()
    window.fetch = previousFetch
  })

  it('isolates XHR open/listener/callback failures and ignores late loads after uninstall', () => {
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([] as unknown as PerformanceEntryList)
    const openError = new Error('original open failure')
    const openMarker = { opened: true }

    class SafetyXhr extends EventTarget {
      throwOnListener = false

      open(_method: string, url: string | URL): unknown {
        if (typeof url === 'string' && url.includes('/throws')) throw openError
        return openMarker
      }

      override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void {
        if (this.throwOnListener) throw new Error('listener rejected')
        super.addEventListener(type, callback, options)
      }
    }

    vi.stubGlobal(
      'XMLHttpRequest',
      SafetyXhr as unknown as typeof XMLHttpRequest
    )
    const report = vi.fn(() => {
      throw new Error('report rejected')
    })
    const sniffer = installYoutubeSniffer(report, PAGE_CTX)

    const listenerFailure = new XMLHttpRequest() as unknown as SafetyXhr
    listenerFailure.throwOnListener = true
    expect(
      listenerFailure.open('GET', 'https://page.test/listener') as unknown
    ).toBe(openMarker)

    const throwingOpen = new XMLHttpRequest()
    expect(() => throwingOpen.open('GET', 'https://page.test/throws')).toThrow(
      openError
    )

    const hostileUrl = {
      toString(): string {
        throw new Error('hostile URL coercion')
      },
    } as URL
    expect(new XMLHttpRequest().open('GET', hostileUrl) as unknown).toBe(
      openMarker
    )

    const reused = new XMLHttpRequest()
    reused.open('GET', VIDEO_URL)
    reused.open('GET', AUDIO_URL)
    expect(() => reused.dispatchEvent(new Event('load'))).not.toThrow()
    expect(report).not.toHaveBeenCalled()

    const video = new XMLHttpRequest()
    video.open('GET', VIDEO_URL)
    expect(() => video.dispatchEvent(new Event('load'))).not.toThrow()
    expect(report).toHaveBeenCalledOnce()

    const lateVideo = new XMLHttpRequest()
    const lateAudio = new XMLHttpRequest()
    lateVideo.open('GET', `${VIDEO_URL}&late=1`)
    lateAudio.open('GET', `${AUDIO_URL}&late=1`)
    report.mockClear()
    sniffer.uninstall()
    lateVideo.dispatchEvent(new Event('load'))
    lateAudio.dispatchEvent(new Event('load'))
    expect(report).not.toHaveBeenCalled()
  })

  it('does not overwrite fetch or XHR patches installed after the sniffer', () => {
    performanceSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([] as unknown as PerformanceEntryList)
    const previousFetch = window.fetch
    const previousOpen = XMLHttpRequest.prototype.open
    const sniffer = installYoutubeSniffer(() => undefined, PAGE_CTX)
    const laterFetch = vi.fn(async () => new Response('later'))
    const laterOpen = vi.fn()
    window.fetch = laterFetch
    XMLHttpRequest.prototype.open =
      laterOpen as unknown as typeof XMLHttpRequest.prototype.open

    sniffer.uninstall()

    expect(window.fetch).toBe(laterFetch)
    expect(XMLHttpRequest.prototype.open).toBe(laterOpen)
    window.fetch = previousFetch
    XMLHttpRequest.prototype.open = previousOpen
  })
})
