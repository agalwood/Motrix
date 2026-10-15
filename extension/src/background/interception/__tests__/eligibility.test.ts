import { describe, expect, it } from 'vitest'
import {
  isEligibleDownload,
  pickDownloadUrl,
} from '@/background/interception/eligibility'

const SELF = 'self-ext-id'

describe('isEligibleDownload', () => {
  it('accepts an http(s) download not initiated by this extension', () => {
    expect(
      isEligibleDownload(
        { finalUrl: 'https://h/f.zip', url: 'https://h/f.zip' },
        SELF
      )
    ).toBe(true)
  })

  it('rejects blob/data/filesystem and non-http schemes', () => {
    expect(
      isEligibleDownload(
        { finalUrl: 'blob:https://h/x', url: 'blob:https://h/x' },
        SELF
      )
    ).toBe(false)
    expect(
      isEligibleDownload(
        { finalUrl: 'data:text/plain,hi', url: 'data:text/plain,hi' },
        SELF
      )
    ).toBe(false)
  })

  it('rejects downloads this extension re-issued (loop guard)', () => {
    expect(
      isEligibleDownload(
        {
          finalUrl: 'https://h/f.zip',
          url: 'https://h/f.zip',
          byExtensionId: SELF,
        },
        SELF
      )
    ).toBe(false)
  })
})

describe('pickDownloadUrl', () => {
  it('prefers a non-empty finalUrl', () => {
    expect(
      pickDownloadUrl({
        url: 'https://a.example/x',
        finalUrl: 'https://cdn.example/y',
      })
    ).toBe('https://cdn.example/y')
  })

  it('falls back to url when finalUrl is empty or absent', () => {
    expect(pickDownloadUrl({ url: 'https://a.example/x', finalUrl: '' })).toBe(
      'https://a.example/x'
    )
    expect(pickDownloadUrl({ url: 'https://a.example/x' })).toBe(
      'https://a.example/x'
    )
  })
})
