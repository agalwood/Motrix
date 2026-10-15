import { describe, expect, it } from 'vitest'
import {
  MAX_MEDIA_REPORT_BYTES_PER_MESSAGE,
  MAX_MEDIA_REPORT_ITEMS_PER_WINDOW,
  MEDIA_REPORT_WINDOW_MS,
  MediaReportLimiter,
} from '@/background/MediaReportLimiter'

function report(count: number, suffix = ''): unknown {
  return {
    tabUrl: 'https://page.example/',
    items: Array.from({ length: count }, (_, index) => ({
      kind: 'direct',
      url: `https://cdn.example/${index}.jpg${suffix}`,
      pageUrl: 'https://page.example/',
      pageTitle: 'Gallery',
    })),
  }
}

describe('MediaReportLimiter', () => {
  it('aggregates floods from many frames under one tab budget', () => {
    const limiter = new MediaReportLimiter(() => 1)
    const packetSize = 20
    const accepted = Array.from({ length: 40 }, () =>
      limiter.allow(7, report(packetSize))
    ).filter(Boolean).length

    expect(accepted * packetSize).toBeLessThanOrEqual(
      MAX_MEDIA_REPORT_ITEMS_PER_WINDOW
    )
    expect(accepted).toBeLessThan(40)
    expect(limiter.allow(8, report(packetSize))).toBe(true)
  })

  it('rejects oversized packets before normalization and resets by window', () => {
    let now = 1
    const limiter = new MediaReportLimiter(() => now)
    expect(
      limiter.allow(
        7,
        report(1, `?token=${'x'.repeat(MAX_MEDIA_REPORT_BYTES_PER_MESSAGE)}`)
      )
    ).toBe(false)
    expect(limiter.allow(7, report(1))).toBe(true)
    limiter.clear(7)
    expect(limiter.allow(7, report(1))).toBe(true)
    now += MEDIA_REPORT_WINDOW_MS + 1
    expect(limiter.allow(7, report(1))).toBe(true)
  })
})
