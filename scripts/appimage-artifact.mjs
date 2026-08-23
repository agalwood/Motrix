import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, stat, truncate } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { parseStrictSemVer } from './release-metadata.mjs'

export const APPIMAGE_TOOLSET_VERSION = '1.0.3'
export const ELECTRON_BUILDER_VERSION = '26.15.7'

const APPIMAGE_ARCH = Object.freeze({
  x64: { artifact: 'x86_64', machine: 0x3e },
  arm64: { artifact: 'arm64', machine: 0xb7 },
})

const ELF64_HEADER_BYTES = 64
const ELF64_PROGRAM_HEADER_BYTES = 56
const ELF64_SECTION_HEADER_BYTES = 64
const MAX_RUNTIME_BYTES = 8 * 1024 * 1024
const MAX_BLOCKMAP_BYTES = 32 * 1024 * 1024
const MAX_ZSYNC_BYTES = 32 * 1024 * 1024

export function expectedAppImageName(version, arch) {
  const architecture = APPIMAGE_ARCH[arch]
  if (!architecture) throw new Error(`Unsupported AppImage arch: ${arch}`)
  return `Motrix-${version}-${architecture.artifact}.AppImage`
}

export function expectedZsyncName(version, arch) {
  return `${expectedAppImageName(version, arch)}.zsync`
}

export function nativeUpdateInformation(version, arch) {
  const metadata = parseStrictSemVer(version, 'AppImage version')
  if (metadata.channel !== 'stable' && metadata.channel !== 'beta') {
    throw new Error(
      `Unsupported AppImage update channel ${metadata.channel}: ${version}`
    )
  }
  const architecture = APPIMAGE_ARCH[arch]
  if (!architecture) throw new Error(`Unsupported AppImage arch: ${arch}`)
  const release = metadata.channel === 'stable' ? 'latest' : 'latest-pre'
  return (
    `gh-releases-zsync|agalwood|Motrix|${release}|` +
    `Motrix-*-${architecture.artifact}.AppImage.zsync`
  )
}

export function appImageArchFromBuilder(arch) {
  if (arch === 1 || arch === 'x64') return 'x64'
  if (arch === 3 || arch === 'arm64') return 'arm64'
  throw new Error(`Unsupported electron-builder AppImage arch: ${arch}`)
}

export function parseAppImageRuntime(runtime, arch) {
  const architecture = APPIMAGE_ARCH[arch]
  if (!architecture) throw new Error(`Unsupported AppImage arch: ${arch}`)
  assertRange(runtime, 0, ELF64_HEADER_BYTES, 'ELF header')
  if (!runtime.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('Artifact is not an ELF (not an AppImage)')
  }
  if (runtime[4] !== 2 || runtime[5] !== 1) {
    throw new Error('AppImage runtime must be a 64-bit little-endian ELF')
  }
  if (runtime[8] !== 0x41 || runtime[9] !== 0x49 || runtime[10] !== 0x02) {
    throw new Error('Missing AppImage type-2 magic (AI\\x02) at offset 8')
  }
  const machine = runtime.readUInt16LE(18)
  if (machine !== architecture.machine) {
    throw new Error(
      `AppImage ELF machine 0x${machine.toString(16)} does not match ${arch} ` +
        `(expected 0x${architecture.machine.toString(16)})`
    )
  }

  const programHeaderOffset = safeUInt64(runtime, 0x20, 'e_phoff')
  const sectionHeaderOffset = safeUInt64(runtime, 0x28, 'e_shoff')
  const programHeaderSize = runtime.readUInt16LE(0x36)
  const programHeaderCount = runtime.readUInt16LE(0x38)
  const sectionHeaderSize = runtime.readUInt16LE(0x3a)
  const sectionHeaderCount = runtime.readUInt16LE(0x3c)
  const sectionNameIndex = runtime.readUInt16LE(0x3e)
  if (
    sectionHeaderOffset === 0 ||
    sectionHeaderSize !== ELF64_SECTION_HEADER_BYTES ||
    sectionHeaderCount < 2 ||
    sectionNameIndex === 0 ||
    sectionNameIndex >= sectionHeaderCount
  ) {
    throw new Error('AppImage runtime has an unsupported ELF section table')
  }
  if (
    programHeaderCount > 0 &&
    programHeaderSize !== ELF64_PROGRAM_HEADER_BYTES
  ) {
    throw new Error('AppImage runtime has an unsupported ELF program table')
  }

  const runtimeBytes =
    sectionHeaderOffset + sectionHeaderSize * sectionHeaderCount
  if (runtimeBytes > MAX_RUNTIME_BYTES) {
    throw new Error(`AppImage runtime is unexpectedly large: ${runtimeBytes}`)
  }
  assertRange(runtime, 0, runtimeBytes, 'complete AppImage runtime')
  assertRange(
    runtime,
    programHeaderOffset,
    programHeaderSize * programHeaderCount,
    'ELF program headers'
  )

  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderSize
    if (runtime.readUInt32LE(offset) === 3) {
      throw new Error(
        'AppImage runtime contains PT_INTERP and is not statically linked'
      )
    }
  }

  const rawSections = []
  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const offset = sectionHeaderOffset + index * sectionHeaderSize
    rawSections.push({
      nameOffset: runtime.readUInt32LE(offset),
      type: runtime.readUInt32LE(offset + 4),
      offset: safeUInt64(runtime, offset + 24, `section ${index} offset`),
      size: safeUInt64(runtime, offset + 32, `section ${index} size`),
    })
  }
  const sectionNameTable = rawSections[sectionNameIndex]
  assertRange(
    runtime,
    sectionNameTable.offset,
    sectionNameTable.size,
    'ELF section-name table'
  )
  const names = runtime.subarray(
    sectionNameTable.offset,
    sectionNameTable.offset + sectionNameTable.size
  )
  const sections = new Map()
  for (const [index, section] of rawSections.entries()) {
    const name = readCString(names, section.nameOffset, `section ${index} name`)
    if (!name) continue
    if (sections.has(name)) throw new Error(`Duplicate ELF section ${name}`)
    if (section.type !== 8) {
      assertRange(runtime, section.offset, section.size, `ELF section ${name}`)
    }
    sections.set(name, section)
  }

  const staticMarker = requiredSection(sections, '.static')
  if (
    runtime
      .subarray(staticMarker.offset, staticMarker.offset + staticMarker.size)
      .toString('utf8') !== 'static'
  ) {
    throw new Error('AppImage runtime is missing the static-runtime marker')
  }

  const dynamic = requiredSection(sections, '.dynamic')
  if (dynamic.size % 16 !== 0) {
    throw new Error('AppImage runtime has a malformed dynamic section')
  }
  for (
    let offset = dynamic.offset;
    offset < dynamic.offset + dynamic.size;
    offset += 16
  ) {
    const tag = runtime.readBigInt64LE(offset)
    if (tag === 0n) break
    if (tag === 1n) {
      throw new Error(
        'AppImage runtime contains a DT_NEEDED dependency and is not static'
      )
    }
  }

  const legacyFuse = runtime.indexOf(Buffer.from('libfuse.so.2'))
  if (legacyFuse >= 0) {
    throw new Error(
      'AppImage runtime still contains legacy libfuse.so.2 loading logic'
    )
  }
  for (const capability of [
    '--appimage-mount',
    '--appimage-extract',
    '--appimage-extract-and-run',
    'TARGET_APPIMAGE',
  ]) {
    if (runtime.indexOf(Buffer.from(capability)) < 0) {
      throw new Error(
        `AppImage static runtime is missing required capability ${capability}`
      )
    }
  }

  return { runtimeBytes, sections }
}

export function readSectionValue(runtime, section, label) {
  const bytes = runtime.subarray(section.offset, section.offset + section.size)
  const nul = bytes.indexOf(0)
  const end = nul < 0 ? bytes.length : nul
  if (nul >= 0 && bytes.subarray(nul).some((value) => value !== 0)) {
    throw new Error(`${label} has non-zero bytes after its terminator`)
  }
  return bytes.subarray(0, end).toString('utf8')
}

export async function inspectAppImageRuntime(file, arch) {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(ELF64_HEADER_BYTES)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (bytesRead !== head.length) throw new Error('AppImage header too short')
    const sectionHeaderOffset = safeUInt64(head, 0x28, 'e_shoff')
    const sectionHeaderSize = head.readUInt16LE(0x3a)
    const sectionHeaderCount = head.readUInt16LE(0x3c)
    const runtimeBytes =
      sectionHeaderOffset + sectionHeaderSize * sectionHeaderCount
    if (
      !Number.isSafeInteger(runtimeBytes) ||
      runtimeBytes < ELF64_HEADER_BYTES ||
      runtimeBytes > MAX_RUNTIME_BYTES
    ) {
      throw new Error(`Invalid AppImage runtime size: ${runtimeBytes}`)
    }
    const runtime = Buffer.alloc(runtimeBytes)
    const result = await handle.read(runtime, 0, runtime.length, 0)
    if (result.bytesRead !== runtime.length) {
      throw new Error('AppImage runtime is truncated')
    }
    return { runtime, ...parseAppImageRuntime(runtime, arch) }
  } finally {
    await handle.close()
  }
}

export function assertAppImageRuntimeMetadata(
  inspection,
  { updateInformation, requireUnsigned = true }
) {
  const updateSection = requiredSection(inspection.sections, '.upd_info')
  const actual = readSectionValue(
    inspection.runtime,
    updateSection,
    'AppImage .upd_info'
  )
  if (actual !== updateInformation) {
    throw new Error(
      `AppImage update information does not match: expected ${updateInformation || '<empty>'}, got ${actual || '<empty>'}`
    )
  }
  if (requireUnsigned) {
    const signature = requiredSection(inspection.sections, '.sha256_sig')
    const bytes = inspection.runtime.subarray(
      signature.offset,
      signature.offset + signature.size
    )
    if (bytes.some((value) => value !== 0)) {
      throw new Error(
        'AppImage native signature is populated; update information must be embedded before native signing'
      )
    }
  }
}

export async function writeAppImageUpdateInformation(file, arch, value) {
  if (value.includes('\0')) {
    throw new Error('AppImage update information must not contain NUL bytes')
  }
  const inspection = await inspectAppImageRuntime(file, arch)
  const section = requiredSection(inspection.sections, '.upd_info')
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length >= section.size) {
    throw new Error(
      `AppImage update information exceeds .upd_info capacity ${section.size}`
    )
  }
  const padded = Buffer.alloc(section.size)
  encoded.copy(padded)
  const handle = await open(file, 'r+')
  try {
    const { bytesWritten } = await handle.write(
      padded,
      0,
      padded.length,
      section.offset
    )
    if (bytesWritten !== padded.length) {
      throw new Error(
        'Failed to write the complete AppImage update information'
      )
    }
  } finally {
    await handle.close()
  }
}

export async function inspectEmbeddedBlockmap(file) {
  const info = await stat(file)
  if (!info.isFile() || info.size < 5) {
    throw new Error('AppImage is too short to contain an embedded blockmap')
  }
  const footer = await readRange(file, info.size - 4, 4)
  const blockMapSize = footer.readUInt32BE(0)
  if (blockMapSize <= 0 || blockMapSize > MAX_BLOCKMAP_BYTES) {
    throw new Error(`Invalid embedded AppImage blockmap size: ${blockMapSize}`)
  }
  const baseSize = info.size - blockMapSize - 4
  if (baseSize <= 0)
    throw new Error('Embedded AppImage blockmap overlaps artifact')
  const compressed = await readRange(file, baseSize, blockMapSize)
  let document
  try {
    document = JSON.parse(inflateRawSync(compressed).toString('utf8'))
  } catch (error) {
    throw new Error(`Invalid embedded AppImage blockmap: ${error.message}`, {
      cause: error,
    })
  }
  const blockFile = document?.files?.[0]
  if (
    document?.version !== '2' ||
    !Array.isArray(document.files) ||
    document.files.length !== 1 ||
    blockFile?.name !== 'file' ||
    blockFile.offset !== 0 ||
    !Array.isArray(blockFile.sizes) ||
    !Array.isArray(blockFile.checksums) ||
    blockFile.sizes.length === 0 ||
    blockFile.sizes.length !== blockFile.checksums.length ||
    !blockFile.sizes.every((size) => Number.isSafeInteger(size) && size > 0) ||
    blockFile.sizes.reduce((sum, size) => sum + size, 0) !== baseSize
  ) {
    throw new Error('Embedded AppImage blockmap has invalid contents')
  }
  return { baseSize, blockMapSize, size: info.size }
}

export async function stripEmbeddedBlockmap(file, expectedBlockMapSize) {
  const blockmap = await inspectEmbeddedBlockmap(file)
  if (
    expectedBlockMapSize !== undefined &&
    blockmap.blockMapSize !== expectedBlockMapSize
  ) {
    throw new Error(
      `Embedded AppImage blockmap size ${blockmap.blockMapSize} does not match electron-builder metadata ${expectedBlockMapSize}`
    )
  }
  await truncate(file, blockmap.baseSize)
  return blockmap
}

export async function verifyZsyncFile({ appImagePath, zsyncPath }) {
  const [appImageInfo, zsyncInfo] = await Promise.all([
    stat(appImagePath),
    stat(zsyncPath).catch(() => null),
  ])
  if (!zsyncInfo?.isFile()) {
    throw new Error(`${path.basename(zsyncPath)} is missing`)
  }
  if (zsyncInfo.size <= 0 || zsyncInfo.size > MAX_ZSYNC_BYTES) {
    throw new Error(`${path.basename(zsyncPath)} has an invalid size`)
  }
  const content = await readFile(zsyncPath)
  const separator = content.indexOf(Buffer.from('\n\n'))
  if (separator < 0 || separator + 2 >= content.length) {
    throw new Error(`${path.basename(zsyncPath)} has no checksum payload`)
  }
  const headers = parseHeaders(content.subarray(0, separator).toString('utf8'))
  const expectedName = path.basename(appImagePath)
  if (headers.get('Filename') !== expectedName) {
    throw new Error(
      `${path.basename(zsyncPath)} Filename must be ${expectedName}`
    )
  }
  if (headers.get('URL') !== expectedName) {
    throw new Error(`${path.basename(zsyncPath)} URL must be ${expectedName}`)
  }
  if (headers.get('Length') !== String(appImageInfo.size)) {
    throw new Error(
      `${path.basename(zsyncPath)} Length does not match AppImage`
    )
  }
  const expectedSha1 = await hashFile(appImagePath, 'sha1', 'hex')
  const legacySha1 = headers.get('SHA-1')?.toLowerCase()
  const fileHash = /^sha-?1:([0-9a-f]{40})$/iu.exec(
    headers.get('File-Hash') ?? ''
  )?.[1]
  if (legacySha1 !== expectedSha1 && fileHash?.toLowerCase() !== expectedSha1) {
    throw new Error(`${path.basename(zsyncPath)} SHA-1 does not match AppImage`)
  }
  for (const required of ['zsync', 'Blocksize', 'Hash-Lengths']) {
    if (!headers.get(required)) {
      throw new Error(`${path.basename(zsyncPath)} is missing ${required}`)
    }
  }
  return { zsync: path.basename(zsyncPath) }
}

function parseHeaders(value) {
  const headers = new Map()
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error(`Malformed zsync header: ${line}`)
    const name = line.slice(0, separator)
    const headerValue = line.slice(separator + 1).trim()
    if (headers.has(name)) throw new Error(`Duplicate zsync header: ${name}`)
    headers.set(name, headerValue)
  }
  return headers
}

function requiredSection(sections, name) {
  const section = sections.get(name)
  if (!section) throw new Error(`AppImage runtime is missing ${name}`)
  return section
}

function safeUInt64(buffer, offset, label) {
  assertRange(buffer, offset, 8, label)
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`)
  }
  return Number(value)
}

function assertRange(buffer, offset, size, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > buffer.length
  ) {
    throw new Error(`${label} is outside the AppImage runtime`)
  }
}

function readCString(buffer, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length) {
    throw new Error(`${label} offset is invalid`)
  }
  const end = buffer.indexOf(0, offset)
  if (end < 0) throw new Error(`${label} is not NUL-terminated`)
  return buffer.subarray(offset, end).toString('utf8')
}

async function readRange(file, position, size) {
  const handle = await open(file, 'r')
  try {
    const output = Buffer.alloc(size)
    const { bytesRead } = await handle.read(output, 0, size, position)
    if (bytesRead !== size) throw new Error(`Short read from ${file}`)
    return output
  } finally {
    await handle.close()
  }
}

function hashFile(file, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest(encoding)))
  })
}
