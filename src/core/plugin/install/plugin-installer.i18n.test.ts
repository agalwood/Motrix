import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CapabilityHost } from '../capabilities/interface'
import { PluginInstaller } from './plugin-installer'

interface FakeEntry {
  name: string
  data: Buffer
}

function crc32(buf: Buffer): number {
  let c = 0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries: FakeEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18)
    lfh.writeUInt32LE(size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    local.push(lfh, nameBuf, e.data)
    const localStart = offset
    offset += lfh.length + nameBuf.length + e.data.length
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(size, 20)
    cdh.writeUInt32LE(size, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(localStart, 42)
    central.push(cdh, nameBuf)
  }
  const localB = Buffer.concat(local)
  const centralB = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralB.length, 12)
  eocd.writeUInt32LE(localB.length, 16)
  return Buffer.concat([localB, centralB, eocd])
}

let tmp: string
let pluginsDir: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-installer-i18n-'))
  pluginsDir = path.join(tmp, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('PluginInstaller manifest i18n', () => {
  it('resolves install consent name and description from bundled locales', async () => {
    const manifest = {
      manifestVersion: 1,
      id: 'example.localized',
      name: '%name%',
      version: '1.0.0',
      description: '%description%',
      categories: ['integration'],
      engines: { motrix: '^2.0.0' },
      main: 'dist/plugin.js',
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {},
      l10n: 'locales',
    }
    const moext = path.join(tmp, 'localized.moext')
    await writeFile(
      moext,
      makeZip([
        {
          name: 'motrix-plugin.json',
          data: Buffer.from(JSON.stringify(manifest), 'utf8'),
        },
        { name: 'dist/plugin.js', data: Buffer.from('console.log(1);') },
        {
          name: 'locales/en-US.json',
          data: Buffer.from(
            JSON.stringify({
              name: 'Localized Plugin',
              description: 'Resolved install summary.',
            }),
            'utf8'
          ),
        },
      ])
    )
    const installer = new PluginInstaller({
      pluginsDir,
      registry: { get: () => undefined } as never,
      stateStore: {} as never,
      capabilityHost: {} as CapabilityHost,
      hostVersion: '2.5.0',
    })

    const staged = await installer.stage(moext, {
      type: 'local',
      absPath: moext,
      fileHash: createHash('sha256')
        .update(await readFile(moext))
        .digest('hex'),
    })

    expect(staged.consent.manifest.name).toBe('Localized Plugin')
    expect(staged.consent.manifest.description).toBe(
      'Resolved install summary.'
    )
  })
})
