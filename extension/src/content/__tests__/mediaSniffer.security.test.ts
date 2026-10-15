import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSniffer } from '@/content/mediaSniffer'
import type { DetectedMedia } from '@/shared/media'

const initialContext = {
  pageUrl: 'https://site.example/old',
  pageTitle: 'Old page',
}

function stubEmptyPerformanceEntries(): void {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
    [] as unknown as PerformanceEntryList
  )
}

function resourceEntry(
  name: string,
  startTime: number,
  duration = 1
): PerformanceResourceTiming {
  return {
    name,
    startTime,
    duration,
    initiatorType: 'fetch',
    decodedBodySize: 0,
  } as PerformanceResourceTiming
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

describe('media sniffer page-API safety', () => {
  it('preserves synchronous fetch throws and promise rejection identity', async () => {
    stubEmptyPerformanceEntries()
    const synchronousError = new Error('synchronous fetch failure')
    const rejection = new Error('fetch rejection')
    const originalFetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/throws')) throw synchronousError
      return Promise.reject(rejection)
    }) as typeof window.fetch
    window.fetch = originalFetch
    const sniffer = installSniffer(() => undefined, initialContext)

    let synchronousResult: Promise<Response> | undefined
    let synchronousThrown: unknown
    try {
      synchronousResult = window.fetch('https://api.example/throws')
    } catch (error) {
      synchronousThrown = error
    }

    // Consume a changed-to-async failure too, so a regression cannot leak an
    // unhandled rejection while this assertion explains the semantic change.
    if (synchronousResult) await synchronousResult.catch(() => undefined)

    expect(synchronousThrown).toBe(synchronousError)
    expect(synchronousResult).toBeUndefined()
    await expect(window.fetch('https://api.example/rejects')).rejects.toBe(
      rejection
    )
    expect(originalFetch).toHaveBeenCalledTimes(2)
    sniffer.uninstall()
  })

  it('returns fulfilled fetch responses even when observation getters or reporting throw', async () => {
    stubEmptyPerformanceEntries()
    const hostileResponse = {
      get url(): string {
        throw new Error('hostile response URL getter')
      },
    } as Response
    const ordinaryResponse = new Response('video', {
      headers: { 'content-type': 'video/mp4' },
    })
    const originalFetch = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes('/hostile') ? hostileResponse : ordinaryResponse
      )
    ) as typeof window.fetch
    window.fetch = originalFetch
    const report = vi.fn(() => {
      throw new Error('relay is unavailable')
    })
    const sniffer = installSniffer(report, initialContext)

    await expect(window.fetch('https://api.example/hostile')).resolves.toBe(
      hostileResponse
    )
    await expect(window.fetch('https://cdn.example/movie.mp4')).resolves.toBe(
      ordinaryResponse
    )

    expect(report).toHaveBeenCalled()
    sniffer.uninstall()
  })

  it('preserves XHR open return/throw behavior and contains load-observation failures', () => {
    stubEmptyPerformanceEntries()
    const openError = new Error('original XHR open failure')
    const openMarker = { opened: true }

    class SafetyXhr extends EventTarget {
      responseURL = 'https://cdn.example/movie.mp4'
      responseType: XMLHttpRequestResponseType = ''
      responseText = ''

      open(_method: string, url: string | URL): unknown {
        if (String(url).includes('/throws')) throw openError
        return openMarker
      }

      getResponseHeader(name: string): string | null {
        if (name === 'content-type') return 'video/mp4'
        return null
      }
    }

    vi.stubGlobal(
      'XMLHttpRequest',
      SafetyXhr as unknown as typeof XMLHttpRequest
    )
    const report = vi.fn(() => {
      throw new Error('report failure')
    })
    const sniffer = installSniffer(report, initialContext)
    const xhr = new XMLHttpRequest()

    expect(xhr.open('GET', 'https://api.example/succeeds') as unknown).toBe(
      openMarker
    )
    expect(() => xhr.dispatchEvent(new Event('load'))).not.toThrow()
    expect(report).toHaveBeenCalled()

    const throwingXhr = new XMLHttpRequest()
    expect(() => throwingXhr.open('GET', 'https://api.example/throws')).toThrow(
      openError
    )
    sniffer.uninstall()
  })

  it('does not inspect or report a late XHR load after uninstall', () => {
    stubEmptyPerformanceEntries()
    const accesses = {
      responseUrl: 0,
      responseType: 0,
      responseText: 0,
      responseHeaders: 0,
    }

    class LateXhr extends EventTarget {
      open(): void {}

      get responseURL(): string {
        accesses.responseUrl += 1
        return 'https://api.example/late'
      }

      get responseType(): XMLHttpRequestResponseType {
        accesses.responseType += 1
        return ''
      }

      get responseText(): string {
        accesses.responseText += 1
        return JSON.stringify({ video: 'https://cdn.example/late.mp4' })
      }

      getResponseHeader(): string | null {
        accesses.responseHeaders += 1
        return 'application/json'
      }
    }

    vi.stubGlobal('XMLHttpRequest', LateXhr as unknown as typeof XMLHttpRequest)
    const report = vi.fn()
    const sniffer = installSniffer(report, initialContext)
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://api.example/late')

    sniffer.uninstall()
    xhr.dispatchEvent(new Event('load'))

    expect(accesses).toEqual({
      responseUrl: 0,
      responseType: 0,
      responseText: 0,
      responseHeaders: 0,
    })
    expect(report).not.toHaveBeenCalled()
  })
})

describe('media sniffer body-inspection budget', () => {
  it('inspects only the per-document budget during a 100-response JSON burst', async () => {
    stubEmptyPerformanceEntries()
    const previousFetch = window.fetch
    let index = 0
    const originalFetch = vi.fn(() => {
      index += 1
      return Promise.resolve(
        new Response(
          JSON.stringify({
            video: `https://cdn.example/burst/${index}.mp4`,
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    }) as typeof window.fetch
    window.fetch = originalFetch
    const reported: DetectedMedia[] = []
    const sniffer = installSniffer(
      (items) => reported.push(...items),
      initialContext
    )

    await Promise.all(
      Array.from({ length: 100 }, (_, requestIndex) =>
        window.fetch(`https://api.example/burst/${requestIndex}`)
      )
    )
    await vi.waitFor(() => {
      expect(
        reported.filter((item) => item.evidence?.includes('body-json'))
      ).toHaveLength(2)
    })

    expect(originalFetch).toHaveBeenCalledTimes(100)
    sniffer.uninstall()
    window.fetch = previousFetch
  })

  it('defers XHR responseText access until after the page load listener returns', async () => {
    stubEmptyPerformanceEntries()
    let nextId = 0
    let responseTextReads = 0

    class BudgetXhr extends EventTarget {
      readonly id: number
      readonly responseURL: string
      responseType: XMLHttpRequestResponseType = ''

      constructor() {
        super()
        nextId += 1
        this.id = nextId
        this.responseURL = `https://api.example/xhr/${this.id}`
      }

      open(): void {}

      get responseText(): string {
        responseTextReads += 1
        return JSON.stringify({
          video: `https://cdn.example/xhr/${this.id}.mp4`,
        })
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null
      }
    }

    vi.stubGlobal(
      'XMLHttpRequest',
      BudgetXhr as unknown as typeof XMLHttpRequest
    )
    const reported: DetectedMedia[] = []
    const sniffer = installSniffer(
      (items) => reported.push(...items),
      initialContext
    )

    for (let requestIndex = 0; requestIndex < 100; requestIndex += 1) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `https://api.example/xhr/${requestIndex}`)
      xhr.dispatchEvent(new Event('load'))
    }
    expect(responseTextReads).toBe(0)

    await Promise.resolve()
    expect(responseTextReads).toBe(8)
    expect(
      reported.filter((item) => item.evidence?.includes('body-json'))
    ).toHaveLength(8)
    sniffer.uninstall()
  })
})

describe('media sniffer resource ownership bounds', () => {
  it('evicts old resource keys while retaining old entry-object ownership across SPA routes', () => {
    const oldEntry = resourceEntry(
      'https://cdn.example/original/master.m3u8',
      1
    )
    let entries: PerformanceResourceTiming[] = [oldEntry]
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(
      () => entries as unknown as PerformanceEntryList
    )
    const reported: DetectedMedia[] = []
    const sniffer = installSniffer(
      (items) => reported.push(...items),
      initialContext
    )

    const populateBatch = (batch: string, count: number, offset: number) => {
      entries = Array.from({ length: count }, (_, index) =>
        resourceEntry(
          `https://cdn.example/${batch}/${index}.m3u8`,
          offset + index
        )
      )
      sniffer.scan({
        pageUrl: initialContext.pageUrl,
        pageTitle: batch,
      })
    }

    // The key-based ownership cache is capped at 4096. Crossing the cap
    // makes the original key reusable, without losing WeakMap ownership of
    // the actual original PerformanceEntry object.
    populateBatch('batch-b', 2_000, 10_000)
    populateBatch('batch-c', 2_000, 20_000)
    populateBatch('batch-d', 100, 30_000)

    reported.length = 0
    const clonedEvictedEntry = resourceEntry(
      oldEntry.name,
      oldEntry.startTime,
      oldEntry.duration
    )
    // Process the new object first: after route cleanup it may belong to the
    // current page, while the actual old object remains owned by the old page
    // through the WeakMap even though both have the same resource key.
    entries = [clonedEvictedEntry, oldEntry]
    sniffer.scan({
      pageUrl: 'https://site.example/current',
      pageTitle: 'Current page',
    })
    expect(reported).toMatchObject([
      {
        url: oldEntry.name,
        pageUrl: 'https://site.example/current',
      },
    ])

    reported.length = 0
    entries = [oldEntry]
    sniffer.scan({
      pageUrl: 'https://site.example/later',
      pageTitle: 'Later page',
    })
    expect(reported).toEqual([])
    sniffer.uninstall()
  })
})

describe('media sniffer mutation workload bounds', () => {
  it('merges descendant mutation roots into their pending ancestor', async () => {
    vi.useFakeTimers()
    stubEmptyPerformanceEntries()
    const ancestor = document.createElement('section')
    ancestor.id = 'ancestor'
    const child = document.createElement('div')
    child.className = 'child'
    ancestor.append(child)
    document.body.append(ancestor)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundImage: 'none',
      content: 'none',
    } as CSSStyleDeclaration)
    const childQuery = vi.spyOn(child, 'querySelectorAll')
    const sniffer = installSniffer(() => undefined, initialContext)
    childQuery.mockClear()

    child.className = 'child changed'
    ancestor.className = 'ancestor changed'
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120)

    expect(childQuery).not.toHaveBeenCalled()
    sniffer.uninstall()
  })

  it('limits style/class mutation scanning to four flushes per second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    stubEmptyPerformanceEntries()
    const target = document.createElement('div')
    target.id = 'animated'
    document.body.append(target)
    const getComputedStyle = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        backgroundImage: 'none',
        content: 'none',
      } as CSSStyleDeclaration)
    const sniffer = installSniffer(() => undefined, initialContext)
    getComputedStyle.mockClear()

    for (let index = 0; index < 4; index += 1) {
      target.className = `frame-${index}`
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(120)
    }
    expect(getComputedStyle).toHaveBeenCalledTimes(12)

    target.className = 'frame-4'
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120)
    expect(getComputedStyle).toHaveBeenCalledTimes(12)

    for (let index = 5; index < 20; index += 1) {
      target.className = `frame-${index}`
      await Promise.resolve()
    }
    await vi.advanceTimersByTimeAsync(399)
    expect(getComputedStyle).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(1)
    expect(getComputedStyle).toHaveBeenCalledTimes(15)
    sniffer.uninstall()
  })

  it('clears detached pending mutation roots when the page route changes', async () => {
    vi.useFakeTimers()
    stubEmptyPerformanceEntries()
    const target = document.createElement('div')
    document.body.append(target)
    const reported: DetectedMedia[] = []
    const sniffer = installSniffer(
      (items) => reported.push(...items),
      initialContext
    )
    reported.length = 0

    target.setAttribute(
      'data-src',
      'https://cdn.example/from-the-old-route.webp'
    )
    await Promise.resolve()
    target.remove()
    sniffer.scan({
      pageUrl: 'https://site.example/new',
      pageTitle: 'New page',
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120)

    expect(reported).toEqual([])
    sniffer.uninstall()
  })
})
