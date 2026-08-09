import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import { builtinTrustSurfaceChanged } from './trust-diff'

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'motrix.url-resolver',
    name: 'URL Resolver',
    version: '1.0.0',
    description: 'x',
    categories: ['network'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: ['storage'],
    optionalPermissions: [],
    hostPermissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  } as PluginManifest
}

describe('builtinTrustSurfaceChanged', () => {
  it('reports no change for a same-surface version bump', () => {
    expect(
      builtinTrustSurfaceChanged(manifest(), manifest({ version: '1.1.0' }))
    ).toEqual({ changed: false, added: [] })
  })

  it('reports added permissions with their band prefixes', () => {
    const r = builtinTrustSurfaceChanged(
      manifest(),
      manifest({
        permissions: ['storage', 'ffmpeg'],
        hostPermissions: ['https://api.example/*'],
      })
    )
    expect(r.changed).toBe(true)
    expect(r.added).toEqual(
      expect.arrayContaining(['perm:ffmpeg', 'host:https://api.example/*'])
    )
  })

  it('does not flag REMOVED permissions', () => {
    expect(
      builtinTrustSurfaceChanged(
        manifest({ permissions: ['storage', 'ffmpeg'] }),
        manifest({ permissions: ['storage'] })
      ).changed
    ).toBe(false)
  })

  it('flags public command schema drift as growth', () => {
    const baseContributes = {
      commands: [
        {
          id: 'motrix.url-resolver.resolve',
          title: 'Resolve URL',
          public: true,
          argsSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          resultSchema: {
            type: 'object',
            properties: { resolved: { type: 'boolean' } },
          },
        },
      ],
    }
    const driftContributes = {
      commands: [
        {
          id: 'motrix.url-resolver.resolve',
          title: 'Resolve URL',
          public: true,
          // Schema change: added a new property
          argsSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              timeout: { type: 'number' },
            },
          },
          resultSchema: {
            type: 'object',
            properties: { resolved: { type: 'boolean' } },
          },
        },
      ],
    }
    const r = builtinTrustSurfaceChanged(
      manifest({ contributes: baseContributes }),
      manifest({ contributes: driftContributes })
    )
    expect(r.changed).toBe(true)
    expect(r.added).toContain('publicCommands')
  })

  it('reports no change when public command schemas remain identical', () => {
    const sameContributes = {
      commands: [
        {
          id: 'motrix.url-resolver.resolve',
          title: 'Resolve URL',
          public: true,
          argsSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          resultSchema: {
            type: 'object',
            properties: { resolved: { type: 'boolean' } },
          },
        },
      ],
    }
    const r = builtinTrustSurfaceChanged(
      manifest({ contributes: sameContributes }),
      manifest({ contributes: sameContributes })
    )
    expect(r.changed).toBe(false)
    expect(r.added).toEqual([])
  })

  it('reports added optional permissions with the opt prefix', () => {
    const r = builtinTrustSurfaceChanged(
      manifest({ optionalPermissions: [] }),
      manifest({ optionalPermissions: ['notify'] })
    )
    expect(r.changed).toBe(true)
    expect(r.added).toEqual(['opt:notify'])
  })
})
