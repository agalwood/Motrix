import { parseDevTrustedExtensions } from '@core/bridge/extension-identity-resolver'
import { describe, expect, it } from 'vitest'

describe('parseDevTrustedExtensions', () => {
  it('returns an empty list when env var is unset', () => {
    expect(parseDevTrustedExtensions(undefined)).toEqual([])
    expect(parseDevTrustedExtensions('')).toEqual([])
  })

  it('parses a single chromium entry', () => {
    expect(
      parseDevTrustedExtensions('chromium:abcdefghijklmnopabcdefghijklmnop')
    ).toEqual([{ id: 'abcdefghijklmnopabcdefghijklmnop', browser: 'chromium' }])
  })

  it('parses a single firefox entry', () => {
    expect(parseDevTrustedExtensions('firefox:moo@bar')).toEqual([
      { id: 'moo@bar', browser: 'firefox' },
    ])
  })

  it('parses multiple comma-separated entries', () => {
    expect(
      parseDevTrustedExtensions('chromium:aaa,firefox:b@c,chromium:ddd')
    ).toEqual([
      { id: 'aaa', browser: 'chromium' },
      { id: 'b@c', browser: 'firefox' },
      { id: 'ddd', browser: 'chromium' },
    ])
  })

  it('tolerates whitespace around entries and the colon', () => {
    expect(
      parseDevTrustedExtensions(' chromium : aaa , firefox : bbb ')
    ).toEqual([
      { id: 'aaa', browser: 'chromium' },
      { id: 'bbb', browser: 'firefox' },
    ])
  })

  it('silently drops malformed entries', () => {
    expect(
      parseDevTrustedExtensions('chromium:good,no-colon,unknown:bad,chromium:')
    ).toEqual([{ id: 'good', browser: 'chromium' }])
  })

  it('drops empty entries between commas', () => {
    expect(parseDevTrustedExtensions(',chromium:x,,firefox:y,')).toEqual([
      { id: 'x', browser: 'chromium' },
      { id: 'y', browser: 'firefox' },
    ])
  })
})
