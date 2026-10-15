import { describe, expect, it } from 'vitest'
import {
  MAX_MEDIA_CREDENTIAL_OBSERVATIONS,
  MEDIA_CREDENTIAL_TTL_MS,
  MediaCredentialStore,
} from '@/background/capture/MediaCredentialStore'

const PAGE = 'https://page.example/watch'

describe('MediaCredentialStore', () => {
  it('keeps request context in memory under an exact tab/page/resource key', () => {
    const store = new MediaCredentialStore(() => 100)
    store.remember({
      tabId: 7,
      pageUrl: PAGE,
      url: 'https://cdn.example/photo.png',
      observedAt: 100,
      requestHeaders: {
        Cookie: 'sid=private',
        Referer: PAGE,
        Authorization: 'Bearer must-not-enter',
      },
    })

    expect(store.get(7, PAGE, 'https://cdn.example/photo.png')).toMatchObject({
      requestHeaders: { Cookie: 'sid=private', Referer: PAGE },
    })
    expect(store.get(8, PAGE, 'https://cdn.example/photo.png')).toBeUndefined()
    expect(store.get(7, PAGE, 'https://cdn.example/other.png')).toBeUndefined()
  })

  it('expires, bounds and clears observations on navigation', () => {
    let now = 1
    const store = new MediaCredentialStore(() => now)
    for (
      let index = 0;
      index <= MAX_MEDIA_CREDENTIAL_OBSERVATIONS;
      index += 1
    ) {
      store.remember({
        tabId: 7,
        pageUrl: PAGE,
        url: `https://cdn.example/${index}.jpg`,
        observedAt: now,
        requestHeaders: {},
      })
    }
    expect(store.get(7, PAGE, 'https://cdn.example/0.jpg')).toBeUndefined()

    store.retainPage(7, 'https://page.example/next')
    expect(
      store.get(
        7,
        PAGE,
        `https://cdn.example/${MAX_MEDIA_CREDENTIAL_OBSERVATIONS}.jpg`
      )
    ).toBeUndefined()

    store.remember({
      tabId: 7,
      pageUrl: PAGE,
      url: 'https://cdn.example/fresh.jpg',
      observedAt: now,
      requestHeaders: {},
    })
    now += MEDIA_CREDENTIAL_TTL_MS + 1
    expect(store.get(7, PAGE, 'https://cdn.example/fresh.jpg')).toBeUndefined()
  })
})
