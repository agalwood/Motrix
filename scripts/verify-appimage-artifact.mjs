import { execFile } from 'node:child_process'
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  assertAppImageRuntimeMetadata,
  expectedAppImageName,
  expectedZsyncName,
  inspectAppImageRuntime,
  inspectEmbeddedBlockmap,
  nativeUpdateInformation,
  verifyZsyncFile,
} from './appimage-artifact.mjs'

// Release-time verification for the Linux AppImage target. Unlike a config-only
// check, this inspects the BUILT artifact itself:
//   1. Exactly one AppImage exists for the built architecture, named per the
//      electron-builder `appImage.artifactName` template.
//   2. It is a regular, executable file.
//   3. Its header is an ELF carrying the AppImage type-2 magic, and its ELF
//      machine matches the target architecture (a wrong-arch or non-AppImage
//      file with the right name is rejected).
//   4. Its runtime is static, has no legacy libfuse.so.2 dependency/loading
//      logic, and preserves a valid electron-updater embedded blockmap.
//   5. Its native AppImage update information selects stable `latest` or beta
//      `latest-pre`, and the matching per-architecture zsync is valid.
//   6. The desktop entry embedded INSIDE the AppImage declares all three
//      handler MimeTypes a browser needs (bittorrent, magnet, motrix:) — read
//      out of the artifact, not from the source config.
// The runtime self-integration (src/main/platform/appimage-integration.ts) is a
// separate, user-scope mechanism.

const execFileAsync = promisify(execFile)

export const REQUIRED_MIME_TYPES = [
  'application/x-bittorrent',
  'x-scheme-handler/magnet',
  'x-scheme-handler/motrix',
]

// ELF e_machine values (offset 18, little-endian u16).
const ELF_MACHINE = {
  x64: 0x3e, // EM_X86_64
  arm64: 0xb7, // EM_AARCH64
}

export { expectedAppImageName }

export function assertDesktopMimeTypes(mimeValue) {
  const mime = typeof mimeValue === 'string' ? mimeValue : ''
  const declared = new Set(mime.split(';').filter(Boolean))
  const missing = REQUIRED_MIME_TYPES.filter((type) => !declared.has(type))
  if (missing.length > 0) {
    throw new Error(
      `AppImage embedded desktop entry is missing MimeType handlers: ${missing.join(', ')}`
    )
  }
}

// Validate the first bytes of the artifact: ELF magic, AppImage type-2 magic
// (`AI\x02` at offset 8), and the ELF machine for the target arch.
export function assertAppImageHeader(head, arch) {
  if (head.length < 20) throw new Error('AppImage header too short')
  const isElf =
    head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
  if (!isElf) throw new Error('Artifact is not an ELF (not an AppImage)')
  const hasAiMagic = head[8] === 0x41 && head[9] === 0x49 && head[10] === 0x02
  if (!hasAiMagic) {
    throw new Error('Missing AppImage type-2 magic (AI\\x02) at offset 8')
  }
  const machine = head[18] | (head[19] << 8)
  const expected = ELF_MACHINE[arch]
  if (machine !== expected) {
    throw new Error(
      `AppImage ELF machine 0x${machine.toString(16)} does not match ${arch} (expected 0x${expected.toString(16)})`
    )
  }
}

// Extract the MimeType line from the AppImage's embedded `.desktop` using
// `unsquashfs` (cross-arch: reads the filesystem without executing the
// binary). Returns the raw MimeType value, or throws if it cannot be read.
async function defaultExtractMimeType(appImagePath) {
  const head = await readHead(appImagePath, 64)
  const offset = squashfsOffset(head)
  if (offset == null) {
    throw new Error('Could not locate the squashfs image inside the AppImage')
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'motrix-appimage-verify-'))
  try {
    await execFileAsync('unsquashfs', [
      '-o',
      String(offset),
      '-d',
      path.join(dir, 'squashfs-root'),
      '-f',
      appImagePath,
    ])
    const root = path.join(dir, 'squashfs-root')
    const names = await readdir(root)
    const desktopName = names.find((n) => n.endsWith('.desktop'))
    if (!desktopName) throw new Error('No .desktop entry in the AppImage')
    const content = await readFile(path.join(root, desktopName), 'utf8')
    return parseMimeTypeFromDesktop(content)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// The squashfs image inside an AppImage begins at the end of the ELF; its start
// is marked by the `hsqs` magic. Read it from the ELF section-header table end,
// falling back to null if the header is unexpected.
function squashfsOffset(head) {
  // e_shoff (u64 LE @ 0x28), e_shentsize (u16 @ 0x3a), e_shnum (u16 @ 0x3c).
  if (head.length < 64) return null
  const shoff = Number(head.readBigUInt64LE(0x28))
  const shentsize = head.readUInt16LE(0x3a)
  const shnum = head.readUInt16LE(0x3c)
  if (!shoff || !shentsize || !shnum) return null
  return shoff + shentsize * shnum
}

function parseMimeTypeFromDesktop(content) {
  let inGroup = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inGroup = line === '[Desktop Entry]'
      continue
    }
    if (!inGroup || !line.startsWith('MimeType=')) continue
    return line.slice('MimeType='.length)
  }
  return ''
}

async function readHead(filePath, n) {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function verifyAppimageArtifact({
  directory,
  version,
  arch,
  // Injectable ports so the checks are unit-testable without a real AppImage.
  statFile = stat,
  readArtifactHead = readHead,
  extractMimeType = defaultExtractMimeType,
  inspectRuntime = inspectAppImageRuntime,
  assertRuntimeMetadata = assertAppImageRuntimeMetadata,
  inspectBlockmap = inspectEmbeddedBlockmap,
  verifyZsync = verifyZsyncFile,
}) {
  if (!version) throw new Error('Expected release version')
  if (!arch) throw new Error('Expected target architecture')
  // expectedAppImageName owns the supported-architecture contract.
  expectedAppImageName(version, arch)

  const entries = await readdir(directory)
  const appImages = entries.filter((name) => name.endsWith('.AppImage'))
  if (appImages.length !== 1) {
    throw new Error(
      `Expected exactly one AppImage for ${arch}, found ${appImages.length}: ${appImages.join(', ')}`
    )
  }

  const expected = expectedAppImageName(version, arch)
  if (appImages[0] !== expected) {
    throw new Error(
      `Unexpected AppImage name ${appImages[0]}; expected ${expected}`
    )
  }

  const zsyncs = entries.filter((name) => name.endsWith('.AppImage.zsync'))
  if (zsyncs.length !== 1) {
    throw new Error(
      `Expected exactly one AppImage zsync for ${arch}, found ${zsyncs.length}: ${zsyncs.join(', ')}`
    )
  }
  const expectedZsync = expectedZsyncName(version, arch)
  if (zsyncs[0] !== expectedZsync) {
    throw new Error(
      `Unexpected AppImage zsync name ${zsyncs[0]}; expected ${expectedZsync}`
    )
  }

  const artifactPath = path.join(directory, expected)
  const zsyncPath = path.join(directory, expectedZsync)

  const info = await statFile(artifactPath)
  if (!info.isFile()) throw new Error(`${expected} is not a regular file`)
  // At least one execute bit must be set (AppImages are run directly).
  if ((info.mode & 0o111) === 0) {
    throw new Error(
      `${expected} is not executable (mode ${info.mode.toString(8)})`
    )
  }

  const head = await readArtifactHead(artifactPath, 64)
  assertAppImageHeader(head, arch)

  const runtime = await inspectRuntime(artifactPath, arch)
  assertRuntimeMetadata(runtime, {
    updateInformation: nativeUpdateInformation(version, arch),
    requireUnsigned: true,
  })
  await inspectBlockmap(artifactPath)
  await verifyZsync({ appImagePath: artifactPath, zsyncPath })

  const mime = await extractMimeType(artifactPath)
  assertDesktopMimeTypes(mime)

  return { appImage: expected, zsync: expectedZsync }
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyAppimageArtifact({
    directory: path.resolve(readArg('--dir') ?? 'release'),
    version:
      readArg('--version') ?? process.env.GITHUB_REF_NAME?.replace(/^v/, ''),
    arch: readArg('--arch'),
  })
  console.log(`Verified AppImage ${result.appImage} and ${result.zsync}`)
}
