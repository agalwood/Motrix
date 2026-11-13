import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript packaging helper
import { nativeEngineDigest } from '../../scripts/native-engine-digest.mjs'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-engine-signature-'))
  roots.push(root)
  return root
}

describe('engine content verification across signing', () => {
  it('excludes PE certificates and checksum while retaining executable content', async () => {
    const root = await directory()
    const original = Buffer.alloc(1024, 0x41)
    original.write('MZ')
    original.writeUInt32LE(64, 0x3c)
    original.writeUInt32LE(0x4550, 64)
    original.writeUInt16LE(0x20b, 88)
    original.writeUInt32LE(0, 88 + 64)
    original.fill(0, 88 + 112 + 32, 88 + 112 + 40)
    const signed = Buffer.concat([original, Buffer.alloc(128, 0x22)])
    signed.writeUInt32LE(12345, 88 + 64)
    signed.writeUInt32LE(original.length, 88 + 112 + 32)
    signed.writeUInt32LE(128, 88 + 112 + 36)
    await writeFile(path.join(root, 'original.exe'), original)
    await writeFile(path.join(root, 'signed.exe'), signed)
    const expected = await nativeEngineDigest(
      path.join(root, 'original.exe'),
      'win32'
    )
    expect(
      await nativeEngineDigest(path.join(root, 'signed.exe'), 'win32')
    ).toBe(expected)
    signed[700] ^= 1
    await writeFile(path.join(root, 'signed.exe'), signed)
    expect(
      await nativeEngineDigest(path.join(root, 'signed.exe'), 'win32')
    ).not.toBe(expected)
  })

  it.skipIf(process.platform !== 'darwin')(
    'accepts macOS re-signing but rejects changed content',
    async () => {
      const root = await directory()
      const source = path.join(root, 'main.c')
      const original = path.join(root, 'original')
      const signed = path.join(root, 'signed')
      await writeFile(source, 'int main(void) { return 0; }\n')
      await execute('clang', ['-Wl,-no_adhoc_codesign', source, '-o', original])
      const expected = await nativeEngineDigest(original, 'darwin')
      await copyFile(original, signed)
      await execute('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        '--identifier',
        'app.motrix.taiji.test',
        signed,
      ])
      expect(await nativeEngineDigest(signed, 'darwin')).toBe(expected)
      const bytes = await readFile(signed)
      bytes[2048] ^= 1
      await writeFile(signed, bytes)
      expect(await nativeEngineDigest(signed, 'darwin')).not.toBe(expected)
    }
  )
})
