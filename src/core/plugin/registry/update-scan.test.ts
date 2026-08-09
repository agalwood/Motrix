import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { describe, expect, it } from 'vitest'
import { scanForUpdates } from './update-scan'

function entry(over: Partial<RegistryPluginDTO> = {}): RegistryPluginDTO {
  return {
    id: 'acme.speed-boost',
    listing: {
      defaultLocale: 'en-US',
      localizations: { 'en-US': { name: 'x', description: 'x' } },
    },
    version: '1.1.0',
    author: { name: 'Acme' },
    origin: 'community',
    categories: ['network'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-07-01',
    featured: false,
    compatible: true,
    package: {
      url: 'https://dl.motrix.app/p/x.moext',
      sha256: 'a'.repeat(64),
      size: 10,
    },
    ...over,
  }
}

const INSTALLED = { id: 'acme.speed-boost', version: '1.0.0' }

describe('scanForUpdates', () => {
  it('reports a newer compatible registry entry as a community update', () => {
    expect(scanForUpdates([INSTALLED], [entry()])).toEqual([
      {
        pluginId: 'acme.speed-boost',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        channel: 'community',
      },
    ])
  })

  it('skips builtin- and dev-sourced installs', () => {
    expect(
      scanForUpdates(
        [
          { ...INSTALLED, source: { type: 'builtin' } },
          { ...INSTALLED, source: { type: 'dev' } },
        ],
        [entry({ origin: 'community' })]
      )
    ).toEqual([])
  })

  it('skips incompatible entries, missing packages, and missing entries', () => {
    expect(scanForUpdates([INSTALLED], [entry({ compatible: false })])).toEqual(
      []
    )
    expect(
      scanForUpdates([INSTALLED], [entry({ package: undefined })])
    ).toEqual([])
    expect(
      scanForUpdates([{ id: 'other.plugin', version: '1.0.0' }], [entry()])
    ).toEqual([])
  })

  it('skips equal and older registry versions', () => {
    expect(scanForUpdates([INSTALLED], [entry({ version: '1.0.0' })])).toEqual(
      []
    )
    expect(scanForUpdates([INSTALLED], [entry({ version: '0.9.0' })])).toEqual(
      []
    )
  })

  it('reports a signed newer builtin entry on the builtin channel', () => {
    const e = entry({
      id: 'motrix.url-resolver',
      origin: 'builtin',
      version: '1.1.0',
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
        signature: 'c2ln',
      },
    })
    expect(
      scanForUpdates(
        [
          {
            id: 'motrix.url-resolver',
            version: '1.0.0',
            source: { type: 'builtin' },
          },
        ],
        [e]
      )
    ).toEqual([
      {
        pluginId: 'motrix.url-resolver',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        channel: 'builtin',
      },
    ])
  })

  it('scans hot-updated builtins by their overlay version', () => {
    const e = entry({
      id: 'motrix.url-resolver',
      origin: 'builtin',
      version: '1.1.0',
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
        signature: 'c2ln',
      },
    })
    expect(
      scanForUpdates(
        [
          {
            id: 'motrix.url-resolver',
            version: '1.1.0',
            source: { type: 'builtin-update' },
          },
        ],
        [e]
      )
    ).toEqual([])
  })

  it('never offers an UNSIGNED builtin entry', () => {
    const e = entry({
      id: 'motrix.url-resolver',
      origin: 'builtin',
      version: '1.1.0',
      // package without signature
    })
    expect(
      scanForUpdates(
        [
          {
            id: 'motrix.url-resolver',
            version: '1.0.0',
            source: { type: 'builtin' },
          },
        ],
        [e]
      )
    ).toEqual([])
  })
})
