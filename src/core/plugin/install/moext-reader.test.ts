import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractLoadedMoext,
  extractMoext,
  loadMoext,
  readMoextEntry,
} from './moext-reader'

// Minimal zip writer for fixtures. yauzl reads what we write here, so we keep
// it on the central directory + local file header format with no compression.
// That keeps the fixture builder small and deterministic.

interface FakeEntry {
  name: string
  data: Buffer
  externalAttrUpper16?: number // for symlink mode bits
}

function crc32(buf: Buffer): number {
  let c = 0
  for (let i = 0; i < buf.length; i++) {
    c = c ^ buf[i]
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries: FakeEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length

    // Local file header
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0x800, 6) // UTF-8 names
    lfh.writeUInt16LE(0, 8) // compression: stored
    lfh.writeUInt16LE(0, 10) // mod time
    lfh.writeUInt16LE(0, 12) // mod date
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18) // compressed
    lfh.writeUInt32LE(size, 22) // uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra len
    localParts.push(lfh, nameBuf, e.data)
    const localStart = offset
    offset += lfh.length + nameBuf.length + e.data.length

    // Central directory header
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0x800, 8) // UTF-8 names
    cdh.writeUInt16LE(0, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(size, 20)
    cdh.writeUInt32LE(size, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30) // extra
    cdh.writeUInt16LE(0, 32) // comment
    cdh.writeUInt16LE(0, 34) // disk
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(((e.externalAttrUpper16 ?? 0) << 16) >>> 0, 38)
    cdh.writeUInt32LE(localStart, 42)
    centralParts.push(cdh, nameBuf)
  }

  const local = Buffer.concat(localParts)
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(local.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([local, central, eocd])
}

const SYMLINK_MODE = 0o120755
const VALID_MANIFEST = JSON.stringify({
  manifestVersion: 1,
  id: 'com.example.test',
  name: 'Test Plugin',
  version: '1.0.0',
  description: 'a fixture',
  categories: ['utilities'],
  engines: { motrix: '^2.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: {},
})
const TINY_BUNDLE = Buffer.from('export default function(){};', 'utf8')
let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-moext-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFixture(name: string, buf: Buffer): Promise<string> {
  const p = path.join(tmp, name)
  await writeFile(p, buf)
  return p
}

async function expectPathCollision(
  fixtureName: string,
  entries: FakeEntry[]
): Promise<void> {
  const dest = path.join(tmp, `${fixtureName}-dest`)
  const moext = await writeFixture(`${fixtureName}.moext`, makeZip(entries))
  await expect(extractMoext(moext, dest)).rejects.toMatchObject({
    message: 'plugin.install.path_collision',
  })
  expect(existsSync(dest)).toBe(false)
}

describe('moext-reader', () => {
  it('valid bundle extracts and preserves bundle digest semantics', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ])
    const moext = await writeFixture('valid.moext', moextBuf)
    const dest = path.join(tmp, 'unpacked')
    const result = await extractMoext(moext, dest)
    expect(result.bundleSha256).toBe(
      createHash('sha256').update(TINY_BUNDLE).digest('hex')
    )
    expect(JSON.parse(result.manifestRaw).id).toBe('com.example.test')
    const onDisk = await readFile(path.join(dest, 'dist/plugin.js'))
    expect(onDisk.equals(TINY_BUNDLE)).toBe(true)
  })

  it('retains a complete-archive digest independently of the bundle digest', async () => {
    const baseEntries = [
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ]
    const first = makeZip([
      ...baseEntries,
      { name: 'dist/alternate.js', data: Buffer.from('first') },
    ])
    const second = makeZip([
      ...baseEntries,
      { name: 'dist/alternate.js', data: Buffer.from('second') },
    ])

    const firstLoaded = await loadMoext(
      await writeFixture('first.moext', first)
    )
    const secondLoaded = await loadMoext(
      await writeFixture('second.moext', second)
    )
    const firstResult = await extractLoadedMoext(
      firstLoaded,
      path.join(tmp, 'first')
    )
    const secondResult = await extractLoadedMoext(
      secondLoaded,
      path.join(tmp, 'second')
    )

    expect(firstLoaded.archiveSha256).not.toBe(secondLoaded.archiveSha256)
    expect(firstResult.bundleSha256).toBe(secondResult.bundleSha256)
  })

  it('rejects retained package bytes that no longer match their digest', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ])
    const loaded = await loadMoext(
      await writeFixture('mutated.moext', moextBuf)
    )
    loaded.bytes[0] ^= 0xff

    await expect(
      extractLoadedMoext(loaded, path.join(tmp, 'mutated'))
    ).rejects.toMatchObject({ message: 'plugin.install.sha256_mismatch' })
  })

  it('keeps Linux-valid case, Unicode, colon, trailing-dot, and reserved names usable', async () => {
    if (process.platform !== 'linux') return
    const entries: FakeEntry[] = [
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
      { name: 'assets/Name.txt', data: Buffer.from('upper', 'utf8') },
      { name: 'assets/name.txt', data: Buffer.from('lower', 'utf8') },
      { name: 'assets/café.json', data: Buffer.from('nfc', 'utf8') },
      { name: 'assets/cafe\u0301.json', data: Buffer.from('nfd', 'utf8') },
      { name: 'assets/name:part', data: Buffer.from('colon', 'utf8') },
      { name: 'assets/trailing.', data: Buffer.from('dot', 'utf8') },
      { name: 'assets/CON', data: Buffer.from('reserved', 'utf8') },
    ]
    const dest = path.join(tmp, 'linux-valid-dest')
    const moext = await writeFixture('linux-valid.moext', makeZip(entries))

    await extractMoext(moext, dest)

    expect(await readFile(path.join(dest, 'assets/Name.txt'), 'utf8')).toBe(
      'upper'
    )
    expect(await readFile(path.join(dest, 'assets/name.txt'), 'utf8')).toBe(
      'lower'
    )
    expect(await readFile(path.join(dest, 'assets/name:part'), 'utf8')).toBe(
      'colon'
    )
  })

  it('allows ordinary path components containing two dots', async () => {
    const dest = path.join(tmp, 'two-dots-dest')
    const moext = await writeFixture(
      'two-dots.moext',
      makeZip([
        {
          name: 'motrix-plugin.json',
          data: Buffer.from(VALID_MANIFEST, 'utf8'),
        },
        { name: 'dist/plugin.js', data: TINY_BUNDLE },
        { name: 'assets/name..part', data: Buffer.from('dots', 'utf8') },
      ])
    )

    await extractMoext(moext, dest)

    expect(await readFile(path.join(dest, 'assets/name..part'), 'utf8')).toBe(
      'dots'
    )
  })

  it('rejects exact duplicate paths', async () => {
    await expectPathCollision('exact-collision', [
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
      { name: 'assets/data.json', data: Buffer.from('{}', 'utf8') },
      { name: 'assets/data.json', data: Buffer.from('{"x":1}', 'utf8') },
    ])
  })

  it('maps an exclusive-create EEXIST to path_collision', async () => {
    const dest = path.join(tmp, 'preexisting-dest')
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, 'motrix-plugin.json'), 'keep')
    const moext = await writeFixture(
      'preexisting.moext',
      makeZip([
        {
          name: 'motrix-plugin.json',
          data: Buffer.from(VALID_MANIFEST, 'utf8'),
        },
        { name: 'dist/plugin.js', data: TINY_BUNDLE },
      ])
    )

    await expect(extractMoext(moext, dest)).rejects.toMatchObject({
      message: 'plugin.install.path_collision',
    })
    expect(await readFile(path.join(dest, 'motrix-plugin.json'), 'utf8')).toBe(
      'keep'
    )
  })

  it('rejects file-directory prefix conflicts in either entry order', async () => {
    const requiredEntries: FakeEntry[] = [
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ]
    await expectPathCollision('file-before-child', [
      ...requiredEntries,
      { name: 'assets', data: Buffer.from('file', 'utf8') },
      { name: 'assets/payload.js', data: Buffer.from('child', 'utf8') },
    ])
    await expectPathCollision('child-before-file', [
      ...requiredEntries,
      { name: 'assets/payload.js', data: Buffer.from('child', 'utf8') },
      { name: 'assets', data: Buffer.from('file', 'utf8') },
    ])
  })

  it('zip-slip "../escape.txt" rejected', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: '../escape.txt', data: Buffer.from('pwn', 'utf8') },
    ])
    const moext = await writeFixture('slip.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.install.zip_slip' })
  })

  it('absolute-path entry "/etc/passwd" rejected', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: '/etc/passwd', data: Buffer.from('x', 'utf8') },
    ])
    const moext = await writeFixture('abs.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.install.zip_slip' })
  })

  it('backslash entry is normalized by yauzl but missing bundle writes nothing', async () => {
    // yauzl 3.x rewrites '\' to '/' before handing the entry to us. The
    // resulting name 'a/b/c' is a valid nested path inside destDir, so the
    // path validation accepts that contained name, but the full preflight sees
    // the required bundle is missing before creating the destination tree.
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'a\\b\\c', data: Buffer.from('x', 'utf8') },
    ])
    const moext = await writeFixture('back.moext', moextBuf)
    const dest = path.join(tmp, 'unpacked')
    await expect(extractMoext(moext, dest)).rejects.toMatchObject({
      message: 'plugin.install.bundle_missing',
    })
    expect(existsSync(dest)).toBe(false)
  })

  it('symlink entry rejected via external-attr mode', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      {
        name: 'dist/plugin.js',
        data: Buffer.from('../../../etc/passwd', 'utf8'),
        externalAttrUpper16: SYMLINK_MODE,
      },
    ])
    const moext = await writeFixture('symlink.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.install.zip_symlink' })
  })

  it('bundle > 1 MB rejected via uncompressedSize', async () => {
    const big = Buffer.alloc((1 << 20) + 1, 0x61) // 1 MB + 1
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: big },
    ])
    const moext = await writeFixture('big.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.manifest.bundle_too_large' })
  })

  it('missing manifest at root rejected', async () => {
    const moextBuf = makeZip([{ name: 'dist/plugin.js', data: TINY_BUNDLE }])
    const moext = await writeFixture('no-manifest.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({
      message: 'plugin.install.manifest_not_at_root',
    })
  })

  it('missing bundle (no dist/plugin.js) rejected', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
    ])
    const moext = await writeFixture('no-bundle.moext', moextBuf)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.install.bundle_missing' })
  })

  it('total .moext file > 5 MB rejected at stat boundary', async () => {
    const big = Buffer.alloc((5 << 20) + 1, 0x62)
    const moext = await writeFixture('over.moext', big)
    await expect(
      extractMoext(moext, path.join(tmp, 'unpacked'))
    ).rejects.toMatchObject({ message: 'plugin.manifest.bundle_too_large' })
  })
})

// -----------------------------------------------------------------------
// readMoextEntry — in-memory single-entry lookup (Firefox packed-XPI read
// path, 2026-07-18 design §4). Used by PluginRegistry.applyOverlay (manifest)
// and PluginHost (executed code) once bundle.moext's signature has been
// verified, so neither ever has to trust the separately-tamperable extracted
// tree again.
// -----------------------------------------------------------------------
describe('readMoextEntry', () => {
  it('returns the exact uncompressed bytes of a matching entry', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ])
    const bytes = await readMoextEntry(moextBuf, 'dist/plugin.js')
    expect(bytes).not.toBeNull()
    expect(bytes?.equals(TINY_BUNDLE)).toBe(true)
  })

  it('returns null when the entry is absent', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
    ])
    const bytes = await readMoextEntry(moextBuf, 'dist/plugin.js')
    expect(bytes).toBeNull()
  })

  it('rejects a traversal entry name encountered while scanning, even when it is not the requested entry', async () => {
    // '../escape.txt' sorts before the requested entry in this fixture, so
    // this exercises the per-entry validation inside the scan loop (mirrors
    // extractMoext validating every entry, not just the one being written) —
    // not just a check on the caller-supplied `entryName` parameter.
    const moextBuf = makeZip([
      { name: '../escape.txt', data: Buffer.from('pwn', 'utf8') },
      { name: 'dist/plugin.js', data: TINY_BUNDLE },
    ])
    await expect(
      readMoextEntry(moextBuf, 'dist/plugin.js')
    ).rejects.toMatchObject({ message: 'plugin.install.zip_slip' })
  })

  it('rejects a traversal requested entryName upfront', async () => {
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
    ])
    await expect(
      readMoextEntry(moextBuf, '../escape.txt')
    ).rejects.toMatchObject({ message: 'plugin.install.zip_slip' })
  })

  it('enforces the per-entry uncompressed size cap', async () => {
    const big = Buffer.alloc((1 << 20) + 1, 0x61) // 1 MB + 1
    const moextBuf = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(VALID_MANIFEST, 'utf8') },
      { name: 'dist/plugin.js', data: big },
    ])
    await expect(
      readMoextEntry(moextBuf, 'dist/plugin.js')
    ).rejects.toMatchObject({ message: 'plugin.manifest.bundle_too_large' })
  })
})
