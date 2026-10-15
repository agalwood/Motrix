import { describe, expect, it } from 'vitest'
import manifestConfig from '#manifest-config'

type GeneratedManifest = {
  content_security_policy?: {
    extension_pages?: string
  }
}

async function manifestFor(mode: string): Promise<GeneratedManifest> {
  return (await manifestConfig({ command: 'build', mode })) as GeneratedManifest
}

describe('extension page content security policy', () => {
  it('keeps Firefox loopback WebSockets from being upgraded to WSS', async () => {
    const manifest = await manifestFor('firefox')
    const policy = manifest.content_security_policy?.extension_pages

    expect(policy).toBe("script-src 'self'; object-src 'self';")
    expect(policy).not.toContain('upgrade-insecure-requests')
  })

  it('leaves Chromium on its browser-provided default policy', async () => {
    const manifest = await manifestFor('chromium')

    expect(manifest.content_security_policy).toBeUndefined()
  })
})
