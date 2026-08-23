import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  assertAppImageRuntimeMetadata,
  expectedAppImageName,
  expectedZsyncName,
  inspectAppImageRuntime,
  inspectEmbeddedBlockmap,
  nativeUpdateInformation,
  parseAppImageRuntime,
  stripEmbeddedBlockmap,
  verifyZsyncFile,
  writeAppImageUpdateInformation,
} from '../../scripts/appimage-artifact.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('AppImage native update metadata', () => {
  it('uses latest for stable and latest-pre for beta, per architecture', () => {
    expect(nativeUpdateInformation('2.0.0', 'x64')).toBe(
      'gh-releases-zsync|agalwood|Motrix|latest|Motrix-*-x86_64.AppImage.zsync'
    )
    expect(nativeUpdateInformation('2.0.0-beta.23', 'arm64')).toBe(
      'gh-releases-zsync|agalwood|Motrix|latest-pre|Motrix-*-arm64.AppImage.zsync'
    )
    expect(expectedAppImageName('2.0.0', 'x64')).toBe(
      'Motrix-2.0.0-x86_64.AppImage'
    )
    expect(expectedZsyncName('2.0.0', 'arm64')).toBe(
      'Motrix-2.0.0-arm64.AppImage.zsync'
    )
  })

  it('rejects unsupported release channels and architectures', () => {
    expect(() => nativeUpdateInformation('2.0.0-rc.1', 'x64')).toThrow(
      'Unsupported AppImage update channel'
    )
    expect(() => nativeUpdateInformation('2.0.0', 'armv7l')).toThrow(
      'Unsupported AppImage arch'
    )
  })
})

describe('static AppImage runtime inspection', () => {
  it('accepts a static runtime and reads empty update/signature sections', () => {
    const runtime = makeRuntime()
    const inspection = parseAppImageRuntime(runtime, 'x64')
    expect(inspection.runtimeBytes).toBe(runtime.length)
    expect(() =>
      assertAppImageRuntimeMetadata(
        { runtime, ...inspection },
        { updateInformation: '', requireUnsigned: true }
      )
    ).not.toThrow()
  })

  it('rejects an interpreter, dynamic dependency, and FUSE2 loader string', () => {
    const interpreted = makeRuntime()
    interpreted.writeUInt32LE(3, 64)
    expect(() => parseAppImageRuntime(interpreted, 'x64')).toThrow('PT_INTERP')

    const needed = makeRuntime()
    needed.writeBigInt64LE(1n, RUNTIME_OFFSETS.dynamic)
    expect(() => parseAppImageRuntime(needed, 'x64')).toThrow('DT_NEEDED')

    const fuse2 = makeRuntime()
    fuse2.write('libfuse.so.2', RUNTIME_OFFSETS.padding, 'utf8')
    expect(() => parseAppImageRuntime(fuse2, 'x64')).toThrow('libfuse.so.2')
  })

  it('rejects populated native signature bytes', () => {
    const runtime = makeRuntime()
    runtime[RUNTIME_OFFSETS.signature] = 1
    const inspection = parseAppImageRuntime(runtime, 'x64')
    expect(() =>
      assertAppImageRuntimeMetadata(
        { runtime, ...inspection },
        { updateInformation: '', requireUnsigned: true }
      )
    ).toThrow('native signature is populated')
  })

  it('writes update information into the fixed ELF section', async () => {
    const directory = await makeTempDir()
    const file = path.join(directory, 'Motrix-2.0.0-x86_64.AppImage')
    await writeFile(file, makeRuntime())
    await chmod(file, 0o755)
    const update = nativeUpdateInformation('2.0.0', 'x64')

    await writeAppImageUpdateInformation(file, 'x64', update)

    const inspection = await inspectAppImageRuntime(file, 'x64')
    expect(() =>
      assertAppImageRuntimeMetadata(inspection, {
        updateInformation: update,
        requireUnsigned: true,
      })
    ).not.toThrow()
  })
})

describe('embedded blockmap inspection', () => {
  it('validates and strips the electron-updater blockmap footer', async () => {
    const directory = await makeTempDir()
    const file = path.join(directory, 'Motrix.AppImage')
    const base = Buffer.from('complete AppImage bytes')
    const document = {
      version: '2',
      files: [
        {
          name: 'file',
          offset: 0,
          checksums: ['fixture-checksum'],
          sizes: [base.length],
        },
      ],
    }
    const compressed = deflateRawSync(Buffer.from(JSON.stringify(document)))
    const footer = Buffer.alloc(4)
    footer.writeUInt32BE(compressed.length)
    await writeFile(file, Buffer.concat([base, compressed, footer]))

    await expect(inspectEmbeddedBlockmap(file)).resolves.toMatchObject({
      baseSize: base.length,
      blockMapSize: compressed.length,
    })
    await stripEmbeddedBlockmap(file, compressed.length)
    await expect(readFile(file)).resolves.toEqual(base)
  })

  it('rejects malformed blockmap metadata', async () => {
    const directory = await makeTempDir()
    const file = path.join(directory, 'Motrix.AppImage')
    await writeFile(file, Buffer.from('not a blockmap\0\0\0\0'))
    await expect(inspectEmbeddedBlockmap(file)).rejects.toThrow(
      'Invalid embedded AppImage blockmap size'
    )
  })
})

describe('zsync verification', () => {
  it('binds Filename, URL, Length, and SHA-1 to the final AppImage', async () => {
    const directory = await makeTempDir()
    const appImagePath = path.join(directory, 'Motrix-2.0.0-x86_64.AppImage')
    const zsyncPath = `${appImagePath}.zsync`
    const content = Buffer.from('final AppImage including embedded blockmap')
    await writeFile(appImagePath, content)
    await writeFile(zsyncPath, makeZsync(path.basename(appImagePath), content))

    await expect(verifyZsyncFile({ appImagePath, zsyncPath })).resolves.toEqual(
      { zsync: path.basename(zsyncPath) }
    )

    const changed = Buffer.from('changed AppImage')
    await writeFile(appImagePath, changed)
    await expect(verifyZsyncFile({ appImagePath, zsyncPath })).rejects.toThrow(
      'Length does not match AppImage'
    )
  })

  it('accepts the current File-Hash form as well as legacy SHA-1', async () => {
    const directory = await makeTempDir()
    const appImagePath = path.join(directory, 'Motrix-2.0.0-arm64.AppImage')
    const zsyncPath = `${appImagePath}.zsync`
    const content = Buffer.from('arm64 AppImage')
    await writeFile(appImagePath, content)
    await writeFile(
      zsyncPath,
      makeZsync(path.basename(appImagePath), content).replace(
        /SHA-1: ([0-9a-f]{40})/u,
        'File-Hash: SHA-1:$1'
      )
    )
    await expect(
      verifyZsyncFile({ appImagePath, zsyncPath })
    ).resolves.toMatchObject({ zsync: path.basename(zsyncPath) })
  })
})

const RUNTIME_OFFSETS = {
  names: 128,
  static: 256,
  padding: 300,
  update: 512,
  signature: 1536,
  dynamic: 2560,
  sections: 4096,
}

function makeRuntime() {
  const names = Buffer.from(
    '\0.shstrtab\0.static\0.upd_info\0.sha256_sig\0.dynamic\0'
  )
  const sectionCount = 6
  const runtime = Buffer.alloc(RUNTIME_OFFSETS.sections + sectionCount * 64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(runtime)
  runtime[4] = 2
  runtime[5] = 1
  runtime[6] = 1
  runtime[8] = 0x41
  runtime[9] = 0x49
  runtime[10] = 0x02
  runtime.writeUInt16LE(2, 16)
  runtime.writeUInt16LE(0x3e, 18)
  runtime.writeUInt32LE(1, 20)
  runtime.writeBigUInt64LE(64n, 0x20)
  runtime.writeBigUInt64LE(BigInt(RUNTIME_OFFSETS.sections), 0x28)
  runtime.writeUInt16LE(64, 0x34)
  runtime.writeUInt16LE(56, 0x36)
  runtime.writeUInt16LE(1, 0x38)
  runtime.writeUInt16LE(64, 0x3a)
  runtime.writeUInt16LE(sectionCount, 0x3c)
  runtime.writeUInt16LE(1, 0x3e)
  runtime.writeUInt32LE(1, 64)
  names.copy(runtime, RUNTIME_OFFSETS.names)
  runtime.write('static', RUNTIME_OFFSETS.static, 'utf8')
  Buffer.from(
    '--appimage-mount\0--appimage-extract\0--appimage-extract-and-run\0TARGET_APPIMAGE'
  ).copy(runtime, RUNTIME_OFFSETS.padding)

  writeSection(
    runtime,
    1,
    names,
    '.shstrtab',
    3,
    RUNTIME_OFFSETS.names,
    names.length
  )
  writeSection(runtime, 2, names, '.static', 1, RUNTIME_OFFSETS.static, 6)
  writeSection(runtime, 3, names, '.upd_info', 1, RUNTIME_OFFSETS.update, 1024)
  writeSection(
    runtime,
    4,
    names,
    '.sha256_sig',
    1,
    RUNTIME_OFFSETS.signature,
    1024
  )
  writeSection(runtime, 5, names, '.dynamic', 6, RUNTIME_OFFSETS.dynamic, 16)
  return runtime
}

function writeSection(
  runtime: Buffer,
  index: number,
  names: Buffer,
  name: string,
  type: number,
  offset: number,
  size: number
) {
  const header = RUNTIME_OFFSETS.sections + index * 64
  runtime.writeUInt32LE(names.indexOf(Buffer.from(`${name}\0`)), header)
  runtime.writeUInt32LE(type, header + 4)
  runtime.writeBigUInt64LE(BigInt(offset), header + 24)
  runtime.writeBigUInt64LE(BigInt(size), header + 32)
}

function makeZsync(name: string, appImage: Buffer) {
  const sha1 = createHash('sha1').update(appImage).digest('hex')
  return (
    `zsync: 0.6.2\n` +
    `Filename: ${name}\n` +
    `Blocksize: 2048\n` +
    `Length: ${appImage.length}\n` +
    `Hash-Lengths: 1,2,4\n` +
    `URL: ${name}\n` +
    `SHA-1: ${sha1}\n\n` +
    'checksum-payload'
  )
}

async function makeTempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'motrix-appimage-'))
  tempDirs.push(directory)
  return directory
}
