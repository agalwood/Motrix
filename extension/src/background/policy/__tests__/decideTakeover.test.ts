import { describe, expect, it } from 'vitest'
import { decideTakeover } from '@/background/policy/decideTakeover'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

function target(over: Partial<TakeoverTarget> = {}): TakeoverTarget {
  return {
    url: 'https://cdn.example.com/big.zip',
    pageUrl: 'https://example.com/page',
    pageTitle: 'Page',
    suggestedFilename: 'big.zip',
    mime: 'application/zip',
    sizeBytes: 50 * 1024 * 1024,
    siteHint: 'cdn.example.com',
    origin: 'auto',
    ...over,
  }
}

function cfg(over: Partial<TakeoverConfig> = {}): TakeoverConfig {
  return {
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    unknownSizeAction: 'chrome',
    rules: [],
    ...over,
  }
}

describe('decideTakeover', () => {
  it('returns chrome when disabled', () => {
    expect(decideTakeover(cfg({ enabled: false }), target())).toBe('chrome')
  })

  it('always routes an explicit context-menu pick to motrix even when disabled', () => {
    // A right-click "Download with Motrix" is explicit user intent, not a
    // candidate for the auto-interception opt-in. It must hand off regardless
    // of config.enabled — otherwise the right-click silently does nothing
    // whenever "Send eligible downloads to Motrix" is off.
    expect(
      decideTakeover(
        cfg({ enabled: false }),
        target({ origin: 'context-menu' })
      )
    ).toBe('motrix')
  })

  it('routes a context-menu pick to motrix even when a rule would send it to chrome', () => {
    // Auto-interception rules decide which browser-initiated downloads to
    // grab; they are irrelevant to an explicit pick. The user chose Motrix.
    const c = cfg({
      rules: [
        { id: 'd', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    expect(
      decideTakeover(
        c,
        target({
          origin: 'context-menu',
          url: 'https://cdn.example.com/big.zip',
        })
      )
    ).toBe('motrix')
  })

  it('defaults to motrix when enabled and no rule matches', () => {
    expect(decideTakeover(cfg(), target())).toBe('motrix')
  })

  it('denylist host-suffix match routes to chrome (first match wins)', () => {
    const c = cfg({
      rules: [
        { id: 'd', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    expect(
      decideTakeover(c, target({ url: 'https://cdn.example.com/big.zip' }))
    ).toBe('chrome')
  })

  it('keeps downloads from an excluded page in the browser even when a different CDN serves the file', () => {
    const c = cfg({
      rules: [
        { id: 'site', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    const download = target({ url: 'https://cdn.other.test/file.zip' })
    expect(decideTakeover(c, download)).toBe('chrome')
    expect(
      decideTakeover(c, { ...download, pageUrl: 'https://notexample.com/page' })
    ).toBe('motrix')
    expect(decideTakeover(c, { ...download, origin: 'context-menu' })).toBe(
      'motrix'
    )
  })

  it('below-threshold rule routes small files to chrome; large stay motrix', () => {
    const c = cfg({
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: 1 * 1024 * 1024 }))).toBe(
      'chrome'
    )
    expect(decideTakeover(c, target({ sizeBytes: 50 * 1024 * 1024 }))).toBe(
      'motrix'
    )
  })

  it('keeps unknown sizes in the browser when a minimum size is configured', () => {
    const c = cfg({
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: null }))).toBe('chrome')
    expect(
      decideTakeover(c, target({ sizeBytes: null, origin: 'context-menu' }))
    ).toBe('motrix')
  })

  it('takes over files exactly at the minimum size', () => {
    const c = cfg({
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: 10 * 1024 * 1024 }))).toBe(
      'motrix'
    )
  })

  it.each(['chrome', 'motrix'] as const)(
    'routes unknown sizes to the selected handler: %s, with or without a minimum',
    (unknownSizeAction) => {
      for (const rules of [
        [],
        [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' as const }],
      ]) {
        const c = cfg({ unknownSizeAction, rules })
        expect(decideTakeover(c, target({ sizeBytes: null }))).toBe(
          unknownSizeAction
        )
      }
    }
  )

  it('still leaves known small files in the browser when unknown sizes go to Motrix', () => {
    const c = cfg({
      unknownSizeAction: 'motrix',
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: 1024 }))).toBe('chrome')
  })

  it('honors site exclusions and disabled takeover before the unknown-size choice', () => {
    const c = cfg({
      unknownSizeAction: 'motrix',
      rules: [
        { id: 'site', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    expect(decideTakeover(c, target({ sizeBytes: null }))).toBe('chrome')
    expect(
      decideTakeover(
        cfg({ enabled: false, unknownSizeAction: 'motrix' }),
        target({ sizeBytes: null })
      )
    ).toBe('chrome')
  })

  it('does not use an unknown size as evidence for a Motrix allow rule', () => {
    expect(
      decideTakeover(
        cfg({
          defaultAction: 'chrome',
          rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'motrix' }],
        }),
        target({ sizeBytes: null })
      )
    ).toBe('chrome')
  })

  it("treats the model's 'ask' action as chrome in the MVP", () => {
    const c = cfg({ rules: [{ id: 'a', match: {}, action: 'ask' }] })
    expect(decideTakeover(c, target())).toBe('chrome')
  })
})
