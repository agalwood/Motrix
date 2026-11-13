import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { sha256Hex } from './engine-source.mjs'

const execute = promisify(execFile)
export const ENGINE_DIGEST_ALGORITHM = 'native-content-v1'

function machoCommands(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) return []
  const commands = []
  const count = bytes.readUInt32LE(16)
  if (count > 4096) throw new Error('Invalid Mach-O command count')
  let offset = 32
  for (let index = 0; index < count; index++) {
    if (offset + 8 > bytes.length) throw new Error('Truncated Mach-O commands')
    const cmd = bytes.readUInt32LE(offset)
    const size = bytes.readUInt32LE(offset + 4)
    if (size < 8 || offset + size > bytes.length)
      throw new Error('Invalid Mach-O command size')
    commands.push({ cmd, offset, size })
    offset += size
  }
  return commands
}

function unsignedPe(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return bytes
  const pe = bytes.readUInt32LE(0x3c)
  const optional = pe + 24
  if (optional + 2 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550)
    return bytes
  const magic = bytes.readUInt16LE(optional)
  const directory =
    optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0)
  if (directory === optional || directory + 40 > bytes.length) return bytes
  const signature = directory + 32
  const certificateOffset = bytes.readUInt32LE(signature)
  const certificateBytes = bytes.readUInt32LE(signature + 4)
  let end = bytes.length
  if (certificateOffset || certificateBytes) {
    if (
      certificateOffset < directory + 40 ||
      certificateBytes < 8 ||
      certificateOffset + certificateBytes !== bytes.length
    )
      throw new Error('Invalid PE certificate bounds')
    end = certificateOffset
  }
  const result = Buffer.from(bytes.subarray(0, end))
  result.writeUInt32LE(0, optional + 64)
  result.fill(0, signature, signature + 8)
  return result
}

/** Hash code/content while excluding only the platform signing transformation. */
export async function nativeEngineDigest(file, platform) {
  let bytes = await readFile(file)
  if (platform === 'win32') return sha256Hex(unsignedPe(bytes))
  if (platform !== 'darwin') return sha256Hex(bytes)
  const commands = machoCommands(bytes)
  if (commands.some(({ cmd }) => cmd === 0x1d)) {
    if (process.platform !== 'darwin')
      throw new Error('Signed Mach-O content verification requires macOS')
    const directory = await mkdtemp(
      path.join(tmpdir(), 'motrix-engine-digest-')
    )
    const copy = path.join(directory, 'engine')
    try {
      await copyFile(file, copy, constants.COPYFILE_FICLONE)
      await execute('/usr/bin/codesign', ['--remove-signature', copy], {
        timeout: 10000,
        maxBuffer: 64 * 1024,
      })
      bytes = await readFile(copy)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  // codesign restores file content and file sizes, but retains the previous
  // signature's __LINKEDIT VM reservation. It is not part of the executable payload.
  for (const { cmd, offset, size } of machoCommands(bytes)) {
    if (
      cmd === 0x19 &&
      size >= 72 &&
      bytes.toString('ascii', offset + 8, offset + 24).replace(/\0.*$/, '') ===
        '__LINKEDIT'
    ) {
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(offset + 48), offset + 32)
    }
  }
  return sha256Hex(bytes)
}
