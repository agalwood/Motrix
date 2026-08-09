#!/usr/bin/env node

import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { parseStrictSemVer } from '../../scripts/release-metadata.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PACKAGE_DIR = path.dirname(SCRIPT_PATH)
const PROJECT_DIR = path.resolve(PACKAGE_DIR, '..', '..')
const TAR_BLOCK_BYTES = 512
const TAR_END_BLOCKS = 2

export const FLATPAK_COMPANION_BINARY = 'motrix-flatpak-native-host'
export const FLATPAK_COMPANION_ARCHES = new Set(['x64', 'arm64'])

const ELF_MACHINE = new Map([
  ['x64', 62],
  ['arm64', 183],
])

export function flatpakCompanionArchiveName(version, arch) {
  assertSafeVersion(version)
  assertSupportedArch(arch)
  return `Motrix-Native-Host-${version}-linux-${arch}.tar.gz`
}

export function parseArgs(argv) {
  const args = {
    version: undefined,
    arch: undefined,
    outputDirectory: undefined,
    binaryPath: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
      }
      index += 1
      return value
    }

    if (flag === '--version') args.version = readValue()
    else if (flag === '--arch') args.arch = readValue()
    else if (flag === '--output-dir') args.outputDirectory = readValue()
    else if (flag === '--binary') args.binaryPath = readValue()
    else throw new Error(`unknown flag: ${token}`)
  }

  if (!args.version) throw new Error('--version is required')
  if (!args.arch) throw new Error('--arch is required')
  return args
}

export async function packageFlatpakCompanion({
  version,
  arch,
  outputDirectory,
  binaryPath,
  readmePath = path.join(PACKAGE_DIR, 'README.md'),
  readmeZhPath = path.join(PACKAGE_DIR, 'README.zh-CN.md'),
  licensePath = path.join(PROJECT_DIR, 'LICENSE'),
  noticesPath = path.join(PROJECT_DIR, 'THIRD_PARTY_NOTICES.md'),
  noticesZhPath = path.join(PROJECT_DIR, 'THIRD_PARTY_NOTICES.zh-CN.md'),
  licensesDirectory = path.join(PROJECT_DIR, 'THIRD_PARTY_LICENSES'),
  sourceDateEpoch = 0,
}) {
  const archiveName = flatpakCompanionArchiveName(version, arch)
  const epoch = parseSourceDateEpoch(sourceDateEpoch)
  const resolvedOutputDirectory = path.resolve(outputDirectory)
  const resolvedBinaryPath = path.resolve(
    binaryPath ??
      path.join(PACKAGE_DIR, 'dist', `linux-${arch}`, FLATPAK_COMPANION_BINARY)
  )

  const [
    binary,
    readme,
    readmeZh,
    license,
    notices,
    noticesZh,
    thirdPartyLicenses,
  ] = await Promise.all([
    readExecutable(resolvedBinaryPath, arch),
    readRegularFile(readmePath, 'English README'),
    readRegularFile(readmeZhPath, 'Chinese README'),
    readRegularFile(licensePath, 'license'),
    readRegularFile(noticesPath, 'third-party notices'),
    readRegularFile(noticesZhPath, 'Chinese third-party notices'),
    readLicenseDirectory(licensesDirectory),
  ])

  const root = archiveName.slice(0, -'.tar.gz'.length)
  const tar = createTarArchive(
    [
      { name: `${root}/`, mode: 0o755, type: 'directory' },
      {
        name: `${root}/${FLATPAK_COMPANION_BINARY}`,
        mode: 0o755,
        type: 'file',
        content: binary,
      },
      {
        name: `${root}/README.md`,
        mode: 0o644,
        type: 'file',
        content: readme,
      },
      {
        name: `${root}/README.zh-CN.md`,
        mode: 0o644,
        type: 'file',
        content: readmeZh,
      },
      {
        name: `${root}/LICENSE`,
        mode: 0o644,
        type: 'file',
        content: license,
      },
      {
        name: `${root}/THIRD_PARTY_NOTICES.md`,
        mode: 0o644,
        type: 'file',
        content: notices,
      },
      {
        name: `${root}/THIRD_PARTY_NOTICES.zh-CN.md`,
        mode: 0o644,
        type: 'file',
        content: noticesZh,
      },
      {
        name: `${root}/THIRD_PARTY_LICENSES/`,
        mode: 0o755,
        type: 'directory',
      },
      ...thirdPartyLicenses.map((entry) => ({
        ...entry,
        name: `${root}/THIRD_PARTY_LICENSES/${entry.name}`,
      })),
    ],
    epoch
  )
  const archive = gzipSync(tar, { level: 9, mtime: 0 })

  await mkdir(resolvedOutputDirectory, { recursive: true })
  const output = path.join(resolvedOutputDirectory, archiveName)
  const handle = await open(output, 'wx', 0o644)
  try {
    await handle.writeFile(archive)
  } finally {
    await handle.close()
  }

  return { archiveName, output }
}

async function readExecutable(filePath, arch) {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`Flatpak companion is not a regular file: ${filePath}`)
  }
  await access(filePath, constants.X_OK).catch(() => {
    throw new Error(`Flatpak companion is not executable: ${filePath}`)
  })
  const content = await readFile(filePath)
  assertElfArchitecture(content, arch, filePath)
  return content
}

async function readRegularFile(filePath, label) {
  const resolved = path.resolve(filePath)
  const info = await lstat(resolved).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${resolved}`)
  }
  return readFile(resolved)
}

async function readLicenseDirectory(directory) {
  const root = path.resolve(directory)
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`third-party license directory is missing: ${root}`)
  }

  const entries = []
  async function walk(current, relative) {
    const children = await readdir(current, { withFileTypes: true })
    children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )
    for (const child of children) {
      if (
        child.name.includes('/') ||
        child.name.includes('\\') ||
        child.name.includes('\0')
      ) {
        throw new Error(`unsafe third-party license name: ${child.name}`)
      }
      const source = path.join(current, child.name)
      const name = relative ? `${relative}/${child.name}` : child.name
      if (child.isDirectory()) {
        entries.push({ name: `${name}/`, mode: 0o755, type: 'directory' })
        await walk(source, name)
      } else if (child.isFile()) {
        entries.push({
          name,
          mode: 0o644,
          type: 'file',
          content: await readRegularFile(source, 'third-party license'),
        })
      } else {
        throw new Error(`third-party license is not a regular entry: ${source}`)
      }
    }
  }
  await walk(root, '')
  if (!entries.some((entry) => entry.type === 'file')) {
    throw new Error(`third-party license directory is empty: ${root}`)
  }
  return entries
}

function assertElfArchitecture(content, arch, filePath) {
  if (
    content.length < 20 ||
    !content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    content[4] !== 2
  ) {
    throw new Error(`Flatpak companion is not a 64-bit ELF file: ${filePath}`)
  }
  const machine =
    content[5] === 1
      ? content.readUInt16LE(18)
      : content[5] === 2
        ? content.readUInt16BE(18)
        : null
  if (machine !== ELF_MACHINE.get(arch)) {
    throw new Error(
      `Flatpak companion is not a linux-${arch} executable: ${filePath}`
    )
  }
}

function createTarArchive(entries, epoch) {
  const chunks = []
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0)
    const header = createTarHeader({
      name: entry.name,
      mode: entry.mode,
      size: content.length,
      epoch,
      type: entry.type,
    })
    chunks.push(header)
    if (content.length > 0) {
      chunks.push(content)
      const padding =
        (TAR_BLOCK_BYTES - (content.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * TAR_END_BLOCKS))
  return Buffer.concat(chunks)
}

function createTarHeader({ name, mode, size, epoch, type }) {
  const { name: headerName, prefix } = splitTarPath(name)
  const nameBytes = Buffer.from(headerName)
  const prefixBytes = Buffer.from(prefix)

  const header = Buffer.alloc(TAR_BLOCK_BYTES)
  nameBytes.copy(header, 0)
  writeTarNumber(header, 100, 8, mode)
  writeTarNumber(header, 108, 8, 0)
  writeTarNumber(header, 116, 8, 0)
  writeTarNumber(header, 124, 12, size)
  writeTarNumber(header, 136, 12, epoch)
  header.fill(0x20, 148, 156)
  header[156] = type === 'directory' ? 0x35 : 0x30
  Buffer.from('ustar\0').copy(header, 257)
  Buffer.from('00').copy(header, 263)
  prefixBytes.copy(header, 345)

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `
  header.write(checksumText, 148, 8, 'ascii')
  return header
}

function splitTarPath(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: '' }
  }

  for (let index = name.length - 1; index > 0; index -= 1) {
    if (name[index] !== '/' || index === name.length - 1) continue
    const prefix = name.slice(0, index)
    const suffix = name.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix }
    }
  }

  throw new Error(`tar entry name is too long: ${name}`)
}

function writeTarNumber(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid tar numeric value: ${value}`)
  }
  const text = value.toString(8)
  if (text.length > length - 1) {
    throw new Error(`tar numeric value is too large: ${value}`)
  }
  buffer.write(`${text.padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function assertSafeVersion(version) {
  try {
    parseStrictSemVer(version, 'companion version')
  } catch {
    throw new Error(`invalid companion version: ${version}`)
  }
}

function assertSupportedArch(arch) {
  if (!FLATPAK_COMPANION_ARCHES.has(arch)) {
    throw new Error(`unsupported Flatpak companion architecture: ${arch}`)
  }
}

function parseSourceDateEpoch(value) {
  const epoch = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`invalid SOURCE_DATE_EPOCH: ${value}`)
  }
  return epoch
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await packageFlatpakCompanion({
      version: args.version,
      arch: args.arch,
      outputDirectory:
        args.outputDirectory ?? path.join(PROJECT_DIR, 'release'),
      binaryPath: args.binaryPath,
      sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? 0,
    })
    process.stdout.write(`packaged Flatpak companion: ${result.output}\n`)
  } catch (error) {
    process.stderr.write(
      `Flatpak companion packaging failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
