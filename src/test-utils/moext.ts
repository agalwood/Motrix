// Shared fixture machinery for the plugin install/update test suites: a tiny
// zip writer (yauzl reads what we write here, so we keep it on the central
// directory + local file header format with no compression), an ephemeral
// Ed25519 keypair helper, and the builtin manifest/package/registry-entry
// builders shared by the BuiltinUpdater test files. Test-only — never
// imported by production code.

import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { RegistryPluginDTO } from '@shared/schemas/registry'

export interface FakeEntry {
  name: string
  data: Buffer
  externalAttrUpper16?: number // for symlink mode bits
}

export function crc32(buf: Buffer): number {
  let c = 0
  for (let i = 0; i < buf.length; i++) {
    c = c ^ buf[i]
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

export function makeZip(entries: FakeEntry[]): Buffer {
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
    lfh.writeUInt16LE(0, 6) // flags
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
    cdh.writeUInt16LE(0, 8)
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

export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (bytes: Buffer) => sign(null, bytes, privateKey).toString('base64'),
  }
}

// ---------------------------------------------------------------------------
// Builtin manifest / package / registry-entry builders — shared by
// builtin-updater.test.ts and e2e-builtin-update.test.ts, which both build
// fixtures for the same id ('motrix.url-resolver') throughout. `id` is a
// defaulted parameter (rather than a hardcoded literal) so the helper stays
// reusable without changing either file's current output.
// ---------------------------------------------------------------------------

export function builtinManifest(
  version: string,
  over: Record<string, unknown> = {},
  id = 'motrix.url-resolver'
): string {
  return JSON.stringify({
    manifestVersion: 1,
    id,
    name: 'URL Resolver',
    version,
    description: 'builtin url resolver',
    categories: ['integration'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  })
}

export function moextOf(
  version: string,
  manifestOver: Record<string, unknown> = {}
): Buffer {
  return makeZip([
    {
      name: 'motrix-plugin.json',
      data: Buffer.from(builtinManifest(version, manifestOver)),
    },
    { name: 'dist/plugin.js', data: Buffer.from(`exports.v='${version}'`) },
  ])
}

export function entryOf(
  bytes: Buffer,
  k: ReturnType<typeof keypair>,
  version: string,
  over: Record<string, unknown> = {}
): RegistryPluginDTO {
  const { package: pkgOver, ...rest } = over
  return {
    id: 'motrix.url-resolver',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'URL Resolver',
          description: 'builtin url resolver',
        },
      },
    },
    version,
    author: { name: 'Motrix' },
    origin: 'builtin',
    categories: ['integration'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-07-01',
    featured: false,
    compatible: true,
    package: {
      url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      signature: k.sign(bytes),
      ...(pkgOver as object | undefined),
    },
    ...rest,
  } as RegistryPluginDTO
}
