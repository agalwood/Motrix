import { expect, it } from 'vitest'
import { createTorrentRequestSchema } from './create-torrent'

it.each(['trackers', 'webSeeds'] as const)(
  'preserves 64 URLs and rejects 65 instead of discarding %s',
  (key) => {
    const urls = Array.from(
      { length: 64 },
      (_, i) => `https://example.org/${i}`
    )
    expect(createTorrentRequestSchema.parse({ [key]: urls })[key]).toEqual(urls)
    expect(
      createTorrentRequestSchema.safeParse({ [key]: [...urls, urls[0]] })
        .success
    ).toBe(false)
  }
)
it('requires a tracker for private torrents and HTTP(S) web seeds', () => {
  expect(createTorrentRequestSchema.safeParse({ private: true }).success).toBe(
    false
  )
  expect(
    createTorrentRequestSchema.safeParse({
      private: true,
      trackers: ['udp://tracker.example:1337'],
    }).success
  ).toBe(true)
  expect(
    createTorrentRequestSchema.safeParse({ webSeeds: ['file:///etc/passwd'] })
      .success
  ).toBe(false)
})
