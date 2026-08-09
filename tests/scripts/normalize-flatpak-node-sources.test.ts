import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { normalizeFlatpakNodeSources } from '../../scripts/normalize-flatpak-node-sources.mjs'

describe('normalizeFlatpakNodeSources', () => {
  it('removes only unused Playwright browser cache sources', () => {
    const electron = {
      type: 'file',
      dest: 'flatpak-node/cache/electron',
      url: 'https://example.test/electron.zip',
    }
    const playwrightArchive = {
      type: 'archive',
      dest: 'flatpak-node/cache/ms-playwright/chromium-1234',
      url: 'https://example.test/chromium.zip',
    }
    const playwrightMarker = {
      type: 'inline',
      dest: 'flatpak-node/cache/ms-playwright/chromium-1234',
      contents: 'flatpak-node-cache',
    }
    const packageTarball = {
      type: 'file',
      dest: 'flatpak-node/pnpm-tarballs',
      url: 'https://registry.npmjs.org/playwright/-/playwright-1.0.0.tgz',
    }

    expect(
      normalizeFlatpakNodeSources([
        electron,
        playwrightArchive,
        playwrightMarker,
        packageTarball,
      ])
    ).toEqual([electron, packageTarball])
  })

  it('rejects a malformed generator output', () => {
    expect(() => normalizeFlatpakNodeSources({})).toThrow(
      'Flatpak Node sources must be an array'
    )
  })
})
