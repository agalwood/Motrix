import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- JavaScript electron-builder hook has no declarations
import { finalizeAppImageArtifact } from '../../scripts/finalize-appimage-artifact.mjs'

describe('finalizeAppImageArtifact', () => {
  it('embeds beta update information before rebuilding blockmap and zsync', async () => {
    const calls: string[] = []
    const event = makeEvent('2.0.0-beta.23', 1, 'x86_64', 12)
    const assertMetadata = vi.fn(
      (_inspection: unknown, options: { updateInformation: string }) => {
        calls.push(`metadata:${options.updateInformation || 'empty'}`)
      }
    )
    const writeUpdateInformation = vi.fn(
      async (_file: string, arch: string, update: string) => {
        calls.push(`write:${arch}:${update}`)
      }
    )
    const generateZsync = vi.fn(
      async (_appImagePath: string, zsyncPath: string) => {
        calls.push(`zsync:${path.basename(zsyncPath)}`)
      }
    )

    await finalizeAppImageArtifact(event, {
      getBuilderVersion: () => '26.15.7',
      inspectRuntime: async () => ({ runtime: Buffer.alloc(0) }),
      assertMetadata,
      stripBlockmap: async (_file: string, size: number) => {
        calls.push(`strip:${size}`)
      },
      writeUpdateInformation,
      appendBlockmap: async () => {
        calls.push('append')
        return { blockMapSize: 24, sha512: 'updated', size: 100 }
      },
      inspectBlockmap: async () => {
        calls.push('inspect-blockmap')
        return { blockMapSize: 24 }
      },
      generateZsync,
      verifyZsync: async () => {
        calls.push('verify-zsync')
      },
    })

    const update =
      'gh-releases-zsync|agalwood|Motrix|latest-pre|Motrix-*-x86_64.AppImage.zsync'
    expect(calls).toEqual([
      'metadata:empty',
      'strip:12',
      `write:x64:${update}`,
      'append',
      'inspect-blockmap',
      `metadata:${update}`,
      'zsync:Motrix-2.0.0-beta.23-x86_64.AppImage.zsync',
      'verify-zsync',
    ])
    expect(event.updateInfo).toEqual({
      blockMapSize: 24,
      sha512: 'updated',
      size: 100,
    })
  })

  it('supports arm64 stable metadata', async () => {
    const event = makeEvent('2.0.0', 3, 'arm64', 12)
    const updates: string[] = []
    await finalizeAppImageArtifact(event, {
      getBuilderVersion: () => '26.15.7',
      inspectRuntime: async () => ({}),
      assertMetadata: () => {},
      stripBlockmap: async () => {},
      writeUpdateInformation: async (
        _file: string,
        arch: string,
        update: string
      ) => updates.push(`${arch}:${update}`),
      appendBlockmap: async () => ({ blockMapSize: 18 }),
      inspectBlockmap: async () => ({ blockMapSize: 18 }),
      generateZsync: async () => {},
      verifyZsync: async () => {},
    })

    expect(updates).toEqual([
      'arm64:gh-releases-zsync|agalwood|Motrix|latest|Motrix-*-arm64.AppImage.zsync',
    ])
  })

  it('pins the supported toolset and electron-builder implementation', async () => {
    const event = makeEvent('2.0.0', 1, 'x86_64', 12)
    event.packager.config.toolsets.appimage = '0.0.0'
    await expect(
      finalizeAppImageArtifact(event, { getBuilderVersion: () => '26.15.7' })
    ).rejects.toThrow('AppImage toolset must be 1.0.3')

    event.packager.config.toolsets.appimage = '1.0.3'
    await expect(
      finalizeAppImageArtifact(event, { getBuilderVersion: () => '27.0.0' })
    ).rejects.toThrow('requires electron-builder 26.15.7')
  })

  it('ignores non-AppImage artifact events', async () => {
    await expect(
      finalizeAppImageArtifact({ target: { name: 'deb' } })
    ).resolves.toBeUndefined()
  })
})

function makeEvent(
  version: string,
  arch: number,
  artifactArch: string,
  blockMapSize: number
) {
  return {
    arch,
    file: `/tmp/Motrix-${version}-${artifactArch}.AppImage`,
    packager: {
      appInfo: { version },
      config: { toolsets: { appimage: '1.0.3' } },
    },
    target: { name: 'appImage' },
    updateInfo: { blockMapSize, sha512: 'initial', size: 80 },
  }
}
