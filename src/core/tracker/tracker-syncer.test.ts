import type { TrackerSource } from '@shared/types/tracker'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackerSyncer } from './tracker-syncer'

const source = (id: string, url: string): TrackerSource => ({
  id,
  label: id,
  url,
  builtin: true,
  enabled: true,
  cdn: false,
})

describe('TrackerSyncer', () => {
  let syncer: TrackerSyncer

  beforeEach(() => {
    syncer = new TrackerSyncer()
    vi.restoreAllMocks()
  })

  it('returns empty result for empty sources', async () => {
    const result = await syncer.fetch([])
    expect(result.trackers).toEqual([])
    expect(Object.keys(result.sourceStatus)).toHaveLength(0)
  })

  it('skips disabled sources', async () => {
    const disabled = { ...source('a', 'http://a.com'), enabled: false }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await syncer.fetch([disabled])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.trackers).toEqual([])
  })

  it('fetches and deduplicates tracker URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        'udp://a.com:1337/announce\nudp://b.com:80\nudp://a.com:1337/announce\n'
      )
    )
    const result = await syncer.fetch([source('s1', 'http://list.com')])
    expect(result.trackers).toEqual([
      'udp://a.com:1337/announce',
      'udp://b.com:80',
    ])
    expect(result.sourceStatus.s1.ok).toBe(true)
    expect(result.sourceStatus.s1.count).toBe(2)
  })

  it('handles partial failures via allSettled', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('udp://ok.com:80\n'))
      .mockRejectedValueOnce(new Error('network error'))

    const result = await syncer.fetch([
      source('good', 'http://good.com'),
      source('bad', 'http://bad.com'),
    ])
    expect(result.trackers).toEqual(['udp://ok.com:80'])
    expect(result.sourceStatus.good.ok).toBe(true)
    expect(result.sourceStatus.bad.ok).toBe(false)
    expect(result.sourceStatus.bad.error).toBe('network error')
  })

  it('populates SourceFetchStatus.urls with per-source URLs on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('udp://a/announce\nudp://b/announce\n')
    )
    const result = await syncer.fetch([source('src-1', 'http://x')])
    expect(result.sourceStatus['src-1'].urls).toEqual([
      'udp://a/announce',
      'udp://b/announce',
    ])
  })

  it('omits SourceFetchStatus.urls when source fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    const result = await syncer.fetch([source('src-2', 'http://y')])
    expect(result.sourceStatus['src-2'].ok).toBe(false)
    expect(result.sourceStatus['src-2'].urls).toBeUndefined()
  })

  it('skips comment lines starting with #', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '# This is a comment\n# Another comment\nudp://valid.com:80\n#trailing\n'
      )
    )
    const result = await syncer.fetch([source('s1', 'http://list.com')])
    expect(result.trackers).toEqual(['udp://valid.com:80'])
  })

  it('filters out lines with disallowed protocols', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        [
          'udp://ok.com:80',
          'http://ok.com:80/announce',
          'https://ok.com/announce',
          'ws://ok.com',
          'wss://ok.com',
          'ftp://disallowed.com',
          'random text',
          '<!DOCTYPE html>',
          'javascript:alert(1)',
        ].join('\n')
      )
    )
    const result = await syncer.fetch([source('s1', 'http://list.com')])
    expect(result.trackers).toEqual([
      'udp://ok.com:80',
      'http://ok.com:80/announce',
      'https://ok.com/announce',
      'ws://ok.com',
      'wss://ok.com',
    ])
  })
})
