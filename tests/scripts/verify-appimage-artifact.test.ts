import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  assertAppImageHeader,
  assertDesktopMimeTypes,
  expectedAppImageName,
  REQUIRED_MIME_TYPES,
  verifyAppimageArtifact,
} from '../../scripts/verify-appimage-artifact.mjs'

const VERSION = '2.0.0'
const FULL_MIME =
  'application/x-bittorrent;x-scheme-handler/magnet;x-scheme-handler/motrix;'
const tempDirs: string[] = []

// ELF e_machine for the arch, plus the ELF + AppImage type-2 magic bytes.
const E_MACHINE = { x64: 0x3e, arm64: 0xb7 }
function makeHead(arch: 'x64' | 'arm64'): Buffer {
  const head = Buffer.alloc(64)
  head[0] = 0x7f
  head[1] = 0x45 // E
  head[2] = 0x4c // L
  head[3] = 0x46 // F
  head[8] = 0x41 // A
  head[9] = 0x49 // I
  head[10] = 0x02 // type 2
  head.writeUInt16LE(E_MACHINE[arch], 18)
  // plausible section-header table so squashfsOffset() is well-defined
  head.writeBigUInt64LE(4096n, 0x28)
  head.writeUInt16LE(64, 0x3a)
  head.writeUInt16LE(2, 0x3c)
  return head
}

const okStat = { isFile: () => true, mode: 0o755 }

// Default injected ports: valid x64 header, executable regular file, full mime.
function ports(
  overrides: {
    head?: Buffer
    stat?: { isFile: () => boolean; mode: number }
    mime?: string
    arch?: 'x64' | 'arm64'
  } = {}
) {
  return {
    statFile: async () => overrides.stat ?? okStat,
    readArtifactHead: async () =>
      overrides.head ?? makeHead(overrides.arch ?? 'x64'),
    extractMimeType: async () => overrides.mime ?? FULL_MIME,
    inspectRuntime: async () => ({}),
    assertRuntimeMetadata: () => {},
    inspectBlockmap: async () => ({}),
    verifyZsync: async () => ({}),
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  )
})

async function makeDir(files: string[], addZsync = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motrix-appimage-'))
  tempDirs.push(dir)
  for (const name of files) await writeFile(path.join(dir, name), name)
  if (addZsync && !files.some((name) => name.endsWith('.AppImage.zsync'))) {
    for (const name of files.filter((name) => name.endsWith('.AppImage'))) {
      await writeFile(path.join(dir, `${name}.zsync`), 'zsync')
    }
  }
  return dir
}

describe('expectedAppImageName', () => {
  it('maps x64 to x86_64 and arm64 to arm64', () => {
    expect(expectedAppImageName(VERSION, 'x64')).toBe(
      'Motrix-2.0.0-x86_64.AppImage'
    )
    expect(expectedAppImageName(VERSION, 'arm64')).toBe(
      'Motrix-2.0.0-arm64.AppImage'
    )
  })

  it('rejects an unsupported architecture', () => {
    expect(() => expectedAppImageName(VERSION, 'armv7l')).toThrow(
      'Unsupported AppImage arch'
    )
  })
})

describe('assertDesktopMimeTypes', () => {
  it('accepts a MimeType value declaring all three handlers', () => {
    expect(() => assertDesktopMimeTypes(FULL_MIME)).not.toThrow()
  })

  it('rejects a value missing a handler', () => {
    expect(() =>
      assertDesktopMimeTypes(
        'application/x-bittorrent;x-scheme-handler/magnet;'
      )
    ).toThrow('x-scheme-handler/motrix')
  })

  it('rejects an empty value', () => {
    expect(() => assertDesktopMimeTypes('')).toThrow(REQUIRED_MIME_TYPES[0])
    expect(() => assertDesktopMimeTypes(undefined)).toThrow(
      REQUIRED_MIME_TYPES[0]
    )
  })
})

describe('assertAppImageHeader', () => {
  it('accepts a valid ELF + AppImage type-2 header for the arch', () => {
    expect(() => assertAppImageHeader(makeHead('x64'), 'x64')).not.toThrow()
    expect(() => assertAppImageHeader(makeHead('arm64'), 'arm64')).not.toThrow()
  })

  it('rejects a non-ELF file', () => {
    const notElf = Buffer.alloc(64)
    expect(() => assertAppImageHeader(notElf, 'x64')).toThrow('not an ELF')
  })

  it('rejects an ELF without the AppImage type-2 magic', () => {
    const head = makeHead('x64')
    head[8] = 0 // clear the AI magic
    expect(() => assertAppImageHeader(head, 'x64')).toThrow('AppImage type-2')
  })

  it('rejects a wrong-architecture ELF', () => {
    // arm64 ELF verified against x64 target
    expect(() => assertAppImageHeader(makeHead('arm64'), 'x64')).toThrow(
      'does not match x64'
    )
  })
})

describe('verifyAppimageArtifact', () => {
  it('accepts exactly one correctly named, valid AppImage', async () => {
    const dir = await makeDir([
      'Motrix-2.0.0-x86_64.AppImage',
      'Motrix-2.0.0-x86_64.AppImage.blockmap',
      'Motrix_2.0.0_amd64.deb',
    ])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports(),
      })
    ).resolves.toEqual({
      appImage: 'Motrix-2.0.0-x86_64.AppImage',
      zsync: 'Motrix-2.0.0-x86_64.AppImage.zsync',
    })
  })

  it('requires the architecture-specific zsync sidecar', async () => {
    const dir = await makeDir(['Motrix-2.0.0-x86_64.AppImage'], false)
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports(),
      })
    ).rejects.toThrow('Expected exactly one AppImage zsync')
  })

  it('rejects a missing AppImage', async () => {
    const dir = await makeDir(['Motrix_2.0.0_amd64.deb'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports(),
      })
    ).rejects.toThrow('Expected exactly one AppImage')
  })

  it('rejects more than one AppImage for a single architecture', async () => {
    const dir = await makeDir([
      'Motrix-2.0.0-x86_64.AppImage',
      'Motrix-2.0.0-arm64.AppImage',
    ])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports(),
      })
    ).rejects.toThrow('Expected exactly one AppImage')
  })

  it('rejects a wrong-arch AppImage name', async () => {
    const dir = await makeDir(['Motrix-2.0.0-arm64.AppImage'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports(),
      })
    ).rejects.toThrow('Unexpected AppImage name')
  })

  it('rejects a non-regular file', async () => {
    const dir = await makeDir(['Motrix-2.0.0-x86_64.AppImage'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports({ stat: { isFile: () => false, mode: 0o755 } }),
      })
    ).rejects.toThrow('not a regular file')
  })

  it('rejects a non-executable AppImage', async () => {
    const dir = await makeDir(['Motrix-2.0.0-x86_64.AppImage'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports({ stat: { isFile: () => true, mode: 0o644 } }),
      })
    ).rejects.toThrow('not executable')
  })

  it('rejects an artifact whose header is not a valid AppImage', async () => {
    const dir = await makeDir(['Motrix-2.0.0-x86_64.AppImage'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports({ head: Buffer.alloc(64) }),
      })
    ).rejects.toThrow('not an ELF')
  })

  it('rejects when the embedded desktop entry omits a handler', async () => {
    const dir = await makeDir(['Motrix-2.0.0-x86_64.AppImage'])
    await expect(
      verifyAppimageArtifact({
        directory: dir,
        version: VERSION,
        arch: 'x64',
        ...ports({ mime: 'application/x-bittorrent;' }),
      })
    ).rejects.toThrow('missing MimeType handlers')
  })
})
