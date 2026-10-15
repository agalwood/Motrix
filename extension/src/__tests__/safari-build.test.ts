import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifySafariManifest } from '#build-verifier'
import manifestConfig from '#manifest-config'

afterEach(() => vi.unstubAllEnvs())

describe('Safari preview manifest', () => {
  it.each([undefined, 'webstore'])(
    'remains Safari with MOTRIX_BUILD=%s',
    async (build) => {
      vi.stubEnv('MOTRIX_BUILD', build)
      const manifest = await manifestConfig({
        command: 'build',
        mode: 'safari',
      })
      expect(() => verifySafariManifest(manifest)).not.toThrow()
      expect(manifest.permissions).toEqual(
        expect.arrayContaining(['storage', 'scripting', 'webRequest'])
      )
      expect(JSON.stringify(manifest)).not.toMatch(/youtube\.com|youtu\.be/)
    }
  )

  it.each(['downloads', 'notifications', 'nativeMessaging'])(
    'rejects accidental %s permission',
    async (permission) => {
      const manifest = await manifestConfig({
        command: 'build',
        mode: 'safari',
      })
      expect(() =>
        verifySafariManifest({
          ...manifest,
          permissions: [...(manifest.permissions ?? []), permission],
        })
      ).toThrow('unavailable permission')
    }
  )

  it('rejects a service worker or persistent background regression', async () => {
    const manifest = await manifestConfig({ command: 'build', mode: 'safari' })
    for (const background of [
      { service_worker: 'background.js', type: 'module' },
      { scripts: ['background.js'], type: 'module', persistent: true },
    ]) {
      expect(() => verifySafariManifest({ ...manifest, background })).toThrow(
        'nonpersistent module background page'
      )
    }
  })
})
