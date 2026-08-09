import type { PluginManifest } from '@shared/types/plugin'
import type {
  InstallRecord,
  TrustSurfaceDiff,
} from '@shared/types/plugin-install'
import { describe, expect, it } from 'vitest'
import { buildConsentPayload } from './consent-payload'

const baseSource: InstallRecord['source'] = {
  type: 'github',
  url: 'https://github.com/example/plugin',
  bundleSha256: 'a'.repeat(64),
  recordedAt: 1_000,
}

function makeManifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'com.example.plugin',
    name: 'Example',
    version: '1.0.0',
    description: 'desc',
    categories: ['utilities'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: ['http'],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  }
}

describe('buildConsentPayload', () => {
  it('lists each manifest permission with its i18n key description', () => {
    const payload = buildConsentPayload(
      makeManifest({ permissions: ['http', 'storage'] }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.permissions).toEqual([
      { name: 'http', description: 'permission.http.description' },
      { name: 'storage', description: 'permission.storage.description' },
    ])
  })

  it('falls back to permission.<name>.description for unknown permissions', () => {
    const payload = buildConsentPayload(
      makeManifest({ permissions: ['custom.future-permission'] }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.permissions).toEqual([
      {
        name: 'custom.future-permission',
        description: 'permission.custom.future-permission.description',
      },
    ])
  })

  it('marks <all_urls> and other broad host patterns as broad', () => {
    const payload = buildConsentPayload(
      makeManifest({
        hostPermissions: ['<all_urls>', 'https://api.example.com/*', '*://*/*'],
      }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.hostPermissions).toEqual([
      { pattern: '<all_urls>', broad: true },
      { pattern: 'https://api.example.com/*', broad: false },
      { pattern: '*://*/*', broad: true },
    ])
  })

  it('annotates invokesCommands with calleeInstalled + title when available', () => {
    const payload = buildConsentPayload(
      makeManifest({ invokesCommands: ['callee.plugin.cmd', 'missing.cmd'] }),
      baseSource,
      null,
      null,
      { 'callee.plugin.cmd': 'Callee Command' },
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.invokesCommands).toEqual([
      {
        commandId: 'callee.plugin.cmd',
        calleeInstalled: true,
        calleeTitle: 'Callee Command',
      },
      { commandId: 'missing.cmd', calleeInstalled: false },
    ])
  })

  it('only includes public-marked commands in publicCommandsExposed', () => {
    const payload = buildConsentPayload(
      makeManifest({
        contributes: {
          commands: [
            { id: 'cmd.public', title: 'Public', public: true },
            { id: 'cmd.private', title: 'Private' },
          ],
        },
      }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.publicCommandsExposed).toEqual([
      { id: 'cmd.public', title: 'Public' },
    ])
  })

  it('always sets notVerified=true in Phase 1A (no signing yet)', () => {
    const payload = buildConsentPayload(
      makeManifest(),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.trustSurface.notVerified).toBe(true)
  })

  it('passes diff through unchanged (null for fresh install)', () => {
    const fresh = buildConsentPayload(
      makeManifest(),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(fresh.diff).toBeNull()

    const diff: TrustSurfaceDiff = {
      permissionsAdded: ['storage'],
      optionalPermissionsAdded: [],
      invokesCommandsAdded: [],
      publicCommandsAdded: [],
      publicCommandsSchemaChanged: [],
      hostPermissionsAdded: [],
      requestedHeapMBIncreased: null,
      enginesMotrixMajorChange: null,
      sourceUrlChanged: null,
    }
    const upgrade = buildConsentPayload(
      makeManifest(),
      baseSource,
      null,
      diff,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(upgrade.diff).toBe(diff)
  })

  it('mirrors manifest header fields (id, name, version, description, author, homepage)', () => {
    const payload = buildConsentPayload(
      makeManifest({
        author: 'A. Maintainer',
        homepage: 'https://example.com',
      }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(payload.manifest).toEqual({
      id: 'com.example.plugin',
      name: 'Example',
      version: '1.0.0',
      description: 'desc',
      author: 'A. Maintainer',
      homepage: 'https://example.com',
    })
  })
})

describe('buildConsentPayload — ffmpegRuntime', () => {
  it('plugin without ffmpeg perm → requiredByPlugin: "none"', () => {
    const c = buildConsentPayload(
      makeManifest({ permissions: ['http'] }),
      baseSource,
      null,
      null,
      {},
      {
        ffmpegDetection: {
          available: true,
          version: '6.0.1',
          binaryPath: '/u/b',
        },
      }
    )
    expect(c.ffmpegRuntime).toEqual({
      available: true,
      version: '6.0.1',
      satisfiesRange: undefined,
      requiredByPlugin: 'none',
    })
  })

  it('plugin requires ffmpeg, runtime missing → required + !available', () => {
    const c = buildConsentPayload(
      makeManifest({
        permissions: ['ffmpeg'],
        engines: { motrix: '>=2.0.0', ffmpeg: '>=4.4' },
      }),
      baseSource,
      null,
      null,
      {},
      { ffmpegDetection: { available: false } }
    )
    expect(c.ffmpegRuntime).toEqual({
      available: false,
      version: undefined,
      satisfiesRange: false,
      requiredByPlugin: 'required',
    })
  })

  it('plugin optional ffmpeg, version too old → optional + !satisfiesRange', () => {
    const c = buildConsentPayload(
      makeManifest({
        permissions: [],
        optionalPermissions: ['ffmpeg'],
        engines: { motrix: '>=2.0.0', ffmpeg: '>=4.4' },
      }),
      baseSource,
      null,
      null,
      {},
      {
        ffmpegDetection: {
          available: true,
          version: '3.4.2',
          binaryPath: '/x',
        },
      }
    )
    expect(c.ffmpegRuntime.satisfiesRange).toBe(false)
    expect(c.ffmpegRuntime.requiredByPlugin).toBe('optional')
  })

  it('plugin requires ffmpeg, runtime satisfies → all green', () => {
    const c = buildConsentPayload(
      makeManifest({
        permissions: ['ffmpeg'],
        engines: { motrix: '>=2.0.0', ffmpeg: '>=4.4' },
      }),
      baseSource,
      null,
      null,
      {},
      {
        ffmpegDetection: {
          available: true,
          version: '6.0.1',
          binaryPath: '/u',
        },
      }
    )
    expect(c.ffmpegRuntime).toEqual({
      available: true,
      version: '6.0.1',
      satisfiesRange: true,
      requiredByPlugin: 'required',
    })
  })
})
