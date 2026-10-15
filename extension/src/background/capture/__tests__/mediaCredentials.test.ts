import { describe, expect, it } from 'vitest'
import type { NetworkMediaCredentialObservation } from '@/background/capture/MediaCredentialStore'
import {
  buildResourceCredentials,
  safeMediaRequestHeaders,
} from '@/background/capture/mediaCredentials'

const PAGE = 'https://page.example/watch'

describe('media credentials', () => {
  it('never forwards Authorization, Cookie, malformed or oversized headers', () => {
    expect(
      safeMediaRequestHeaders({
        Authorization: 'Bearer private',
        Cookie: 'sid=private',
        Referer: PAGE,
        Accept: 'image/*',
        Origin: 'https://page.example\r\nInjected: yes',
        'X-Requested-With': 'x'.repeat(8_193),
      })
    ).toEqual({ Accept: 'image/*', Referer: PAGE })
  })

  it('replays only cookies whose exact name and value were actually sent', async () => {
    const untrusted = await buildResourceCredentials({
      url: 'https://victim.example/private.png',
      userAgent: 'Browser',
    })
    expect(untrusted).toEqual({
      cookies: [],
      headers: {},
    })
    const observation: NetworkMediaCredentialObservation = {
      tabId: 7,
      pageUrl: PAGE,
      url: 'https://cdn.example/video.mp4',
      observedAt: 1,
      requestHeaders: {
        Cookie: 'sid=scoped; theme=dark',
        Referer: 'https://player.example/embed',
        Origin: 'https://player.example/private/path?token=hidden',
        Authorization: 'Bearer legacy-secret',
      },
    }
    const trusted = await buildResourceCredentials({
      url: observation.url,
      observation,
      userAgent: 'Browser',
    })
    expect(trusted.headers).toEqual({
      Referer: 'https://player.example/',
      Origin: 'https://player.example',
      'User-Agent': 'Browser',
    })
    expect(trusted.cookies).toEqual([
      expect.objectContaining({
        name: 'sid',
        value: 'scoped',
        domain: 'cdn.example',
        secure: true,
      }),
      expect.objectContaining({ name: 'theme', value: 'dark' }),
    ])
  })

  it('does not read cookies or invent a Referer when the observed request sent neither', async () => {
    const result = await buildResourceCredentials({
      url: 'https://cross-site.example/photo.jpg',
      observation: {
        tabId: 7,
        pageUrl: PAGE,
        url: 'https://cross-site.example/photo.jpg',
        observedAt: 1,
        requestHeaders: { Accept: 'image/*' },
      },
      userAgent: 'Browser',
    })

    expect(result).toEqual({
      cookies: [],
      headers: { Accept: 'image/*', 'User-Agent': 'Browser' },
    })
  })
})
