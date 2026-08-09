import nativeMessagingExtensions from '@shared/config/native-messaging-extensions.json'
import { describe, expect, it } from 'vitest'

describe('native messaging extension allowlist', () => {
  it('contains unique, browser-valid built-in identities', () => {
    expect(nativeMessagingExtensions.chromium).not.toHaveLength(0)
    expect(nativeMessagingExtensions.firefox).not.toHaveLength(0)

    for (const id of nativeMessagingExtensions.chromium) {
      expect(id).toMatch(/^[a-p]{32}$/)
    }
    for (const id of nativeMessagingExtensions.firefox) {
      expect(id).toMatch(/^[^\s@]+@[^\s@]+$/)
    }

    const all = [
      ...nativeMessagingExtensions.chromium,
      ...nativeMessagingExtensions.firefox,
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})
