import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import {
  assertMatchesRegistryExpectation,
  buildRegistryExpectation,
  type RegistryExpectation,
} from './registry-expectation'

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'acme.speed-boost',
    name: 'Speed Boost',
    version: '1.0.0',
    description: 'x',
    categories: ['network'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: ['storage'],
    optionalPermissions: ['notify'],
    hostPermissions: ['https://api.acme.dev/*'],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  } as PluginManifest
}

const EXPECTED: RegistryExpectation = {
  id: 'acme.speed-boost',
  version: '1.0.0',
  enginesMotrix: '^2.0.0',
  permissions: ['storage'],
  optionalPermissions: ['notify'],
  hostPermissions: ['https://api.acme.dev/*'],
}

describe('assertMatchesRegistryExpectation', () => {
  it('passes when manifest matches and permissions are subsets', () => {
    expect(() =>
      assertMatchesRegistryExpectation(manifest(), EXPECTED)
    ).not.toThrow()
    // fewer permissions than declared is fine (subset)
    expect(() =>
      assertMatchesRegistryExpectation(manifest({ permissions: [] }), EXPECTED)
    ).not.toThrow()
  })

  it.each([
    ['id', manifest({ id: 'acme.other' })],
    ['version', manifest({ version: '1.0.1' })],
    ['engines.motrix', manifest({ engines: { motrix: '^3.0.0' } })],
    ['permissions', manifest({ permissions: ['storage', 'ffmpeg'] })],
    ['optionalPermissions', manifest({ optionalPermissions: ['ffmpeg'] })],
    [
      'hostPermissions',
      manifest({ hostPermissions: ['https://evil.example/*'] }),
    ],
  ])('rejects a %s mismatch', (_axis, m) => {
    expect(() =>
      assertMatchesRegistryExpectation(m as PluginManifest, EXPECTED)
    ).toThrowError(/registry_manifest_mismatch/)
  })
})

describe('buildRegistryExpectation', () => {
  it('copies the pinned fields from a registry entry', () => {
    expect(
      buildRegistryExpectation({
        id: 'acme.speed-boost',
        version: '1.0.0',
        engines: { motrix: '^2.0.0' },
        permissions: ['storage'],
        optionalPermissions: ['notify'],
        hostPermissions: ['https://api.acme.dev/*'],
      } as never)
    ).toEqual(EXPECTED)
  })
})
