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

  // Cross-repo contract: these literals must match the extension's real
  // store identities. The Firefox ID is declared in
  // motrix-extension/packages/ext/manifest.config.ts
  // (browser_specific_settings.gecko.id) and pinned by a mirror test in that
  // repository; changing either side requires changing both.
  it('allowlists the store-signed extension identities', () => {
    expect(nativeMessagingExtensions.chromium).toContain(
      'ibpkjhgpbidfmbmomagmldcdlpbmchgi'
    )
    expect(nativeMessagingExtensions.firefox).toContain(
      'motrix-extension@motrix.app'
    )
  })
})
