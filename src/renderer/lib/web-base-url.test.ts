import { describe, expect, it } from 'vitest'
import { webBaseUrl } from './web-base-url'

describe('web application base URL', () => {
  it.each([
    ['https://nas.local/', 'https://nas.local'],
    [
      'https://nas.local/app/motrix/#/downloads/all',
      'https://nas.local/app/motrix',
    ],
    [
      'https://nas.local/app/motrix/?path=a.torrent#/settings',
      'https://nas.local/app/motrix',
    ],
    ['https://nas.local/app/motrix/index.html', 'https://nas.local/app/motrix'],
  ])('keeps the mount directory for %s', (input, expected) => {
    expect(webBaseUrl(new URL(input))).toBe(expected)
  })
})
