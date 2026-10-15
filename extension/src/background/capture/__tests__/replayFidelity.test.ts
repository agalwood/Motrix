import { describe, expect, it } from 'vitest'
import { isFaithfulReplay } from '@/background/capture/replayFidelity'

describe('isFaithfulReplay', () => {
  it('rejects a probe that returns HTML for a non-HTML download', () => {
    // uupdump.net: the browser downloaded the POST response (a zip); replaying
    // the same URL as GET serves the configuration page instead.
    expect(
      isFaithfulReplay({
        itemMime: 'application/zip',
        suggestedFilename: 'uupdump_win11.zip',
        probedContentType: 'text/html; charset=UTF-8',
      })
    ).toBe(false)
  })

  it('rejects when the browser reported no mime but the name is not an html file', () => {
    expect(
      isFaithfulReplay({
        itemMime: '',
        suggestedFilename: 'setup.exe',
        probedContentType: 'text/html',
      })
    ).toBe(false)
  })

  it('accepts when the download really is an HTML page', () => {
    expect(
      isFaithfulReplay({
        itemMime: 'text/html',
        suggestedFilename: 'page.html',
        probedContentType: 'text/html; charset=UTF-8',
      })
    ).toBe(true)
  })

  it('accepts when the filename says html even though the browser mime is empty', () => {
    expect(
      isFaithfulReplay({
        itemMime: '',
        suggestedFilename: 'archive.htm',
        probedContentType: 'text/html',
      })
    ).toBe(true)
  })

  it('accepts when the probe returns a real file type', () => {
    expect(
      isFaithfulReplay({
        itemMime: 'application/zip',
        suggestedFilename: 'a.zip',
        probedContentType: 'application/zip',
      })
    ).toBe(true)
  })

  it('accepts when the probe could not run — never block on missing evidence', () => {
    expect(
      isFaithfulReplay({
        itemMime: 'application/zip',
        suggestedFilename: 'a.zip',
        probedContentType: null,
      })
    ).toBe(true)
  })

  it('accepts xhtml and other text types that are not the html trap', () => {
    expect(
      isFaithfulReplay({
        itemMime: 'application/pdf',
        suggestedFilename: 'a.pdf',
        probedContentType: 'text/plain',
      })
    ).toBe(true)
  })
})
