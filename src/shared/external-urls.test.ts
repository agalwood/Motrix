import { describe, expect, it } from 'vitest'
import { EXTERNAL_URLS, getNatTroubleshootingUrl } from './external-urls'

describe('getNatTroubleshootingUrl', () => {
  it('points FFmpeg downloads at the standalone motrixapp project', () => {
    expect(EXTERNAL_URLS.github.ffmpegStaticReleases).toBe(
      'https://github.com/motrixapp/ffmpeg-static/releases/latest'
    )
  })

  it('uses the Chinese manual for Chinese locales', () => {
    expect(getNatTroubleshootingUrl('zh-CN')).toBe(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.zh
    )
    expect(getNatTroubleshootingUrl('zh-Hant-TW')).toBe(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.zh
    )
  })

  it('uses the English manual for other locales', () => {
    expect(getNatTroubleshootingUrl('en-US')).toBe(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.en
    )
  })
})
