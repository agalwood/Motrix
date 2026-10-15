import { describe, expect, it } from 'vitest'
import manifestConfig from '#manifest-config'

// Cross-repo contract: the Motrix desktop app allowlists this exact ID in
// Motrix/src/shared/config/native-messaging-extensions.json (mirrored by a
// test there). Native messaging on Firefox only works while both sides agree,
// so changing the ID here requires changing the desktop allowlist in the same
// release — and vice versa.
const STORE_SIGNED_GECKO_ID = 'motrix-extension@motrix.app'

describe('manifest identity', () => {
  it('declares the store-signed Gecko ID for Firefox builds', async () => {
    const manifest = (await manifestConfig({
      command: 'build',
      mode: 'firefox',
    })) as Record<string, unknown>
    const settings = manifest.browser_specific_settings as
      | {
          gecko?: {
            id?: string
            data_collection_permissions?: { required?: string[] }
          }
        }
      | undefined
    expect(settings?.gecko?.id).toBe(STORE_SIGNED_GECKO_ID)
    expect(settings?.gecko?.data_collection_permissions?.required).toEqual([
      'authenticationInfo',
      'browsingActivity',
      'websiteContent',
      'websiteActivity',
    ])
  })
})
