import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNativeBinaryTarget,
  detectNativeBinaryTarget,
} from '../../scripts/native-binary-target.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

function thinMach(arch: 'x64' | 'arm64', littleEndian = true): Buffer {
  const header = Buffer.alloc(8)
  header.set(littleEndian ? [0xcf, 0xfa, 0xed, 0xfe] : [0xfe, 0xed, 0xfa, 0xcf])
  const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007
  if (littleEndian) header.writeUInt32LE(cpu, 4)
  else header.writeUInt32BE(cpu, 4)
  return header
}

function fatMach(arches: Array<'x64' | 'arm64'>, is64 = false): Buffer {
  const entrySize = is64 ? 32 : 20
  const header = Buffer.alloc(8 + arches.length * entrySize)
  header.set(is64 ? [0xca, 0xfe, 0xba, 0xbf] : [0xca, 0xfe, 0xba, 0xbe])
  header.writeUInt32BE(arches.length, 4)
  arches.forEach((arch, index) => {
    header.writeUInt32BE(
      arch === 'arm64' ? 0x0100000c : 0x01000007,
      8 + index * entrySize
    )
  })
  return header
}

function elf(arch: 'x64' | 'arm64', bigEndian = false): Buffer {
  const header = Buffer.alloc(20)
  header.set([0x7f, 0x45, 0x4c, 0x46])
  header[4] = 2
  header[5] = bigEndian ? 2 : 1
  const machine = arch === 'arm64' ? 183 : 62
  if (bigEndian) header.writeUInt16BE(machine, 18)
  else header.writeUInt16LE(machine, 18)
  return header
}

function pe(arch: 'x64' | 'arm64'): Buffer {
  const header = Buffer.alloc(72)
  header.write('MZ')
  header.writeUInt32LE(64, 0x3c)
  header.set([0x50, 0x45, 0, 0], 64)
  header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  return header
}

describe('native binary target detection', () => {
  it.each([
    [thinMach('x64'), { format: 'mach-o', arches: ['x64'] }],
    [thinMach('arm64', false), { format: 'mach-o', arches: ['arm64'] }],
    [fatMach(['x64', 'arm64']), { format: 'mach-o', arches: ['arm64', 'x64'] }],
    [fatMach(['arm64'], true), { format: 'mach-o', arches: ['arm64'] }],
    [elf('x64'), { format: 'elf', arches: ['x64'] }],
    [elf('arm64', true), { format: 'elf', arches: ['arm64'] }],
    [pe('x64'), { format: 'pe', arches: ['x64'] }],
    [pe('arm64'), { format: 'pe', arches: ['arm64'] }],
  ])('detects supported headers', (header, expected) => {
    expect(detectNativeBinaryTarget(header)).toEqual(expected)
  })

  it.each([Buffer.alloc(0), Buffer.from('MZ'), fatMach([]), Buffer.alloc(20)])(
    'rejects truncated or invalid headers',
    (header) => {
      expect(detectNativeBinaryTarget(header)).toBeUndefined()
    }
  )

  it('requires an explicit universal Mach-O allowance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-native-test-'))
    temporaryRoots.push(root)
    const binary = path.join(root, 'universal.node')
    await writeFile(binary, fatMach(['x64', 'arm64']))

    await expect(
      assertNativeBinaryTarget(binary, 'darwin', 'arm64')
    ).rejects.toThrow('universal Mach-O is not allowed')
    await expect(
      assertNativeBinaryTarget(binary, 'darwin', 'arm64', {
        allowUniversal: true,
      })
    ).resolves.toEqual({ format: 'mach-o', arches: ['arm64', 'x64'] })
    await expect(
      assertNativeBinaryTarget(binary, 'linux', 'arm64', {
        allowUniversal: true,
      })
    ).rejects.toThrow('expected linux-arm64')
  })
})
