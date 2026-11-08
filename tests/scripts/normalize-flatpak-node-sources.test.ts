import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  normalizeFlatpakNodeSources,
  normalizeFlatpakNodeSourcesFile,
} from '../../scripts/normalize-flatpak-node-sources.mjs'

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

  it('formats CI temporary output identically to an in-repository artifact', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'motrix-flatpak-node-sources-')
    )
    const filePath = path.join(directory, 'generated-sources.json')
    const sources = [
      {
        type: 'file',
        dest: 'flatpak-node/cache/electron',
        'only-arches': ['x86_64', 'aarch64'],
      },
    ]
    try {
      await writeFile(filePath, JSON.stringify(sources))
      const expected = spawnSync(
        'pnpm',
        [
          'exec',
          'biome',
          'format',
          '--stdin-file-path=flatpak/generated-sources.json',
        ],
        { input: JSON.stringify(sources), encoding: 'utf8' }
      )
      expect(expected.status, expected.stderr).toBe(0)

      await normalizeFlatpakNodeSourcesFile(filePath)

      expect(await readFile(filePath, 'utf8')).toBe(expected.stdout)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
