import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  FfmpegInstallStatus,
  FfmpegPlatform,
  FfmpegTarget,
} from '@shared/schemas/ffmpeg-release'
import {
  FFMPEG_REPOSITORY,
  ffmpegLicenseInventorySchema,
  ffmpegReleaseVersionSchema,
} from '@shared/schemas/ffmpeg-release'
import * as yauzl from 'yauzl'
import { z } from 'zod'
import {
  compareFfmpegReleases,
  sha256,
  verifyFfmpegBinary,
  verifyFfmpegRelease,
} from './verified-release'

const MAX_BINARY = 256 * 1024 * 1024
const MAX_EXTRACTED = 600 * 1024 * 1024
const fileSystemErrorCodes = new Set([
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EDQUOT',
  'EIO',
  'EISDIR',
  'ENOTDIR',
  'EEXIST',
])
const receiptSchema = z
  .object({
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    releaseVersion: ffmpegReleaseVersionSchema,
    arch: z.enum(['x64', 'arm64']),
    platform: z.enum(['darwin', 'linux', 'win32']).default('win32'),
    layoutVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict()
const activeInstalls = new Set<string>()
const statuses = new Map<string, FfmpegInstallStatus>()
export function getFfmpegInstallStatus(
  userDataDir: string
): FfmpegInstallStatus {
  const current = statuses.get(rootFor(userDataDir))
  if (current) return { ...current }
  try {
    const installed = readInstalled(userDataDir)
    return {
      phase: 'installed',
      bytesReceived: 0,
      bytesTotal: 0,
      percent: null,
      releaseVersion: installed.receipt.releaseVersion,
      directory: installed.directory,
      error: null,
    }
  } catch {
    return {
      phase: 'idle',
      bytesReceived: 0,
      bytesTotal: 0,
      percent: null,
      releaseVersion: null,
      directory: null,
      error: null,
    }
  }
}
const downloadHosts = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
const releaseApiSchema = z
  .object({
    tag_name: z.string().max(80),
    draft: z.literal(false),
    prerelease: z.literal(false),
    immutable: z.literal(true),
    published_at: z.iso.datetime(),
    html_url: z.string().max(256),
    assets: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string().max(200),
            state: z.literal('uploaded'),
            size: z.number().int().positive(),
            browser_download_url: z.string().max(512),
          })
          .passthrough()
      )
      .max(128),
  })
  .passthrough()

function rootFor(userDataDir: string) {
  return path.resolve(userDataDir, 'ffmpeg-verified')
}

function assertManagedDirectory(directory: string, allowMissing = false) {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(directory)
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return
    throw error
  }
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' &&
      ((typeof process.getuid === 'function' &&
        info.uid !== process.getuid()) ||
        (info.mode & 0o022) !== 0))
  )
    throw new AppError(
      ErrorCode.FfmpegInstallFailed,
      'Invalid managed FFmpeg directory'
    )
}

async function ensureManagedDirectory(directory: string) {
  // Reject existing links before mkdir can follow them into an external tree.
  assertManagedDirectory(directory, true)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertManagedDirectory(directory)
}

function regularBytes(file: string, limit: number): Buffer {
  const info = lstatSync(file)
  if (!info.isFile() || info.size > limit)
    throw new Error('Invalid FFmpeg receipt file')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > limit ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev
    )
      throw new Error('Invalid FFmpeg receipt file')
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('FFmpeg receipt changed')
      offset += count
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      fstatSync(fd).size !== opened.size
    )
      throw new Error('FFmpeg receipt changed')
    return bytes
  } finally {
    closeSync(fd)
  }
}

function hashBinary(
  file: string,
  expected: string,
  arch: 'x64' | 'arm64',
  platform: FfmpegPlatform
) {
  const info = lstatSync(file)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BINARY) {
    throw new Error('Invalid managed FFmpeg binary')
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size !== info.size
    )
      throw new Error('FFmpeg binary changed')
    const header = Buffer.alloc(Math.min(info.size, 64 * 1024 + 512))
    const size = readSync(fd, header, 0, header.length, 0)
    verifyFfmpegBinary(header.subarray(0, size), platform, arch)
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    let offset = 0
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, offset)
      if (count === 0) break
      offset += count
      if (offset > MAX_BINARY) throw new Error('FFmpeg binary exceeds limits')
      digest.update(chunk.subarray(0, count))
    }
    if (offset !== info.size || digest.digest('hex') !== expected) {
      throw new Error('Managed FFmpeg binary digest mismatch')
    }
  } finally {
    closeSync(fd)
  }
}

function readInstalled(userDataDir: string) {
  const root = rootFor(userDataDir)
  assertManagedDirectory(root)
  const receipt = receiptSchema.parse(
    JSON.parse(
      regularBytes(path.join(root, 'current.json'), 4096).toString('utf8')
    )
  )
  const directory = path.join(
    root,
    'releases',
    receipt.layoutVersion === 2
      ? `${receipt.manifestHash}-${receipt.platform}-${receipt.arch}`
      : receipt.manifestHash
  )
  for (const component of [path.join(root, 'releases'), directory]) {
    assertManagedDirectory(component)
  }
  const raw = regularBytes(
    path.join(directory, 'ffmpeg-manifest.json'),
    1024 * 1024
  )
  const sig = regularBytes(
    path.join(directory, 'ffmpeg-manifest.json.sig'),
    4096
  )
  const verified = verifyFfmpegRelease(
    raw,
    sig,
    receipt.arch,
    undefined,
    receipt.platform
  )
  if (
    verified.manifestHash !== receipt.manifestHash ||
    verified.manifest.releaseVersion !== receipt.releaseVersion
  ) {
    throw new Error('FFmpeg receipt does not match signed manifest')
  }
  return { ...verified, directory, receipt }
}

/** Synchronous pre-spawn guard for cached plugin paths. External installations remain user-managed. */
export function assertManagedFfmpegTrusted(
  userDataDir: string,
  binaryPath: string
) {
  const relative = path.relative(rootFor(userDataDir), path.resolve(binaryPath))
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    return
  const installed = readInstalled(userDataDir)
  const expectedPath = path.join(
    installed.directory,
    installed.target.binaryPath
  )
  if (path.resolve(binaryPath) !== expectedPath)
    throw new Error('Inactive managed FFmpeg version')
  hashBinary(
    expectedPath,
    installed.target.binarySha256,
    installed.target.arch,
    installed.target.platform
  )
  hashBinary(
    path.join(installed.directory, installed.target.ffprobePath),
    installed.target.ffprobeSha256,
    installed.target.arch,
    installed.target.platform
  )
  if (installed.target.platform === 'win32' && process.platform === 'win32') {
    for (const name of [
      installed.target.binaryPath,
      installed.target.ffprobePath,
    ]) {
      const marker = regularBytes(
        path.join(installed.directory, `${name}:Zone.Identifier`),
        4096
      ).toString('utf8')
      if (!/(?:^|\r?\n)ZoneId=3(?:\r?\n|$)/.test(marker))
        throw new Error('Managed FFmpeg Internet origin marker is missing')
    }
  }
  return installed.target
}

/** Project signature verification does not remove Internet-zone treatment or SmartScreen warnings. */
async function markWindowsInternetOrigin(
  directory: string,
  target: FfmpegTarget,
  sourceUrl: string
) {
  if (target.platform !== 'win32' || process.platform !== 'win32') return
  for (const name of [target.binaryPath, target.ffprobePath]) {
    await writeFile(
      path.join(directory, `${name}:Zone.Identifier`),
      `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${sourceUrl}\r\n`,
      { mode: 0o600 }
    )
  }
}

/** Substitute only the conventional userData candidate; do not hijack manual/PATH installs. */
export function resolveManagedFfmpegCandidate(
  userDataDir: string,
  candidate: string,
  platform: FfmpegPlatform = process.platform as FfmpegPlatform
): string {
  if (
    path.resolve(candidate) ===
      path.resolve(
        userDataDir,
        'binaries',
        platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
      ) &&
    existsSync(path.join(rootFor(userDataDir), 'current.json'))
  ) {
    const installed = readInstalled(userDataDir)
    if (installed.target.platform !== platform)
      throw new Error('Managed FFmpeg platform mismatch')
    candidate = path.join(installed.directory, installed.target.binaryPath)
  }
  assertManagedFfmpegTrusted(userDataDir, candidate)
  return candidate
}

async function download(
  url: string,
  limit: number,
  fetcher: typeof fetch,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void
) {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const location = new URL(url)
    if (
      location.protocol !== 'https:' ||
      location.port ||
      location.username ||
      location.password ||
      !downloadHosts.has(location.hostname)
    ) {
      throw new Error('Untrusted FFmpeg download location')
    }
    const response = await fetcher(url, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
    })
    if (
      response.status === 404 &&
      location.hostname === 'api.github.com' &&
      location.pathname === `/repos/${FFMPEG_REPOSITORY}/releases/latest`
    ) {
      await response.body?.cancel()
      throw new AppError(
        ErrorCode.FfmpegReleaseUnavailable,
        'No formal FFmpeg release'
      )
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location')
      await response.body?.cancel()
      if (!next) throw new Error('Missing download redirect')
      url = new URL(next, url).href
      continue
    }
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('content-length')) > limit
    ) {
      await response.body?.cancel()
      throw new Error('FFmpeg download failed or exceeds limits')
    }
    const chunks: Uint8Array[] = []
    let size = 0
    let lastEmit = 0
    const header = response.headers.get('content-length')
    const total = header && /^\d+$/.test(header) ? Number(header) : 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new Error('FFmpeg download exceeds limits')
        chunks.push(value)
        if (Date.now() - lastEmit >= 250) {
          lastEmit = Date.now()
          onProgress?.(size, total)
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* Preserve the primary failure. */
      }
    }
    onProgress?.(size, total || size)
    return Buffer.concat(chunks, size)
  }
  throw new Error('Too many FFmpeg redirects')
}

/** Authenticated archives still get an exact, bounded, regular-file-only extraction policy. */
export function extractVerifiedFfmpeg(
  archive: Buffer,
  destination: string,
  target: FfmpegTarget
) {
  if (
    archive.length !== target.archiveSize ||
    sha256(archive) !== target.archiveSha256
  ) {
    return Promise.reject(new Error('FFmpeg archive digest mismatch'))
  }
  const expected = new Map<string, string | null>([
    [target.binaryPath, target.binarySha256],
    [target.ffprobePath, target.ffprobeSha256],
    ['BUILD-INFO.json', target.buildInfoSha256],
    ['configure.txt', target.configureSha256],
    ['LICENSES.json', target.licensesSha256],
    ['README.txt', null],
    ...target.licenseFiles.map((item): [string, string] => [
      item.path,
      item.sha256,
    ]),
  ])
  if (target.platform === 'linux')
    return extractVerifiedTar(archive, destination, target, expected)
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('Invalid FFmpeg ZIP'))
          return
        }
        const seen = new Set<string>()
        let total = 0
        let failed = false
        const fail = (reason: unknown) => {
          failed = true
          zip.close()
          reject(reason)
        }
        zip.on('error', fail)
        zip.on('end', () => {
          if (failed) return
          if (seen.size !== expected.size) {
            fail(new Error('Incomplete FFmpeg ZIP'))
            return
          }
          void readFile(path.join(destination, 'LICENSES.json'))
            .then((bytes) => {
              const inventory = ffmpegLicenseInventorySchema.parse(
                JSON.parse(bytes.toString('utf8'))
              )
              if (
                inventory.target !== target.target ||
                inventory.files.length !== target.licenseFiles.length ||
                inventory.files.some(
                  (file) =>
                    !target.licenseFiles.some(
                      (expectedFile) =>
                        expectedFile.path === file.path &&
                        expectedFile.sha256 === file.sha256
                    )
                ) ||
                new Set(inventory.files.map((file) => file.path)).size !==
                  inventory.files.length
              ) {
                throw new Error('FFmpeg license inventory mismatch')
              }
              resolve()
            })
            .catch(fail)
        })
        zip.on('entry', (entry: yauzl.Entry) => {
          const name = entry.fileName
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000
          if (
            !expected.has(name) ||
            seen.has(name) ||
            (mode !== 0 && mode !== 0x8000) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            (entry.externalFileAttributes & 0x400) !== 0 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            entry.uncompressedSize > MAX_BINARY ||
            (name !== target.binaryPath &&
              name !== target.ffprobePath &&
              entry.uncompressedSize > 16 * 1024 * 1024) ||
            seen.size >= expected.size
          ) {
            fail(new Error('Unsafe or unexpected FFmpeg ZIP member'))
            return
          }
          seen.add(name)
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError ?? new Error('Invalid ZIP stream'))
              return
            }
            void (async () => {
              const output = path.join(destination, name)
              await mkdir(path.dirname(output), {
                recursive: true,
                mode: 0o700,
              })
              const file = await open(output, 'wx', 0o600)
              const digest = createHash('sha256')
              let size = 0
              try {
                for await (const chunk of stream) {
                  size += chunk.length
                  total += chunk.length
                  if (size > entry.uncompressedSize || total > MAX_EXTRACTED)
                    throw new Error('ZIP expansion exceeds limits')
                  digest.update(chunk)
                  await file.writeFile(chunk)
                }
                const expectedHash = expected.get(name)
                if (
                  size !== entry.uncompressedSize ||
                  (expectedHash !== null &&
                    digest.digest('hex') !== expectedHash)
                ) {
                  throw new Error('FFmpeg ZIP member digest mismatch')
                }
                if (name === target.binaryPath || name === target.ffprobePath) {
                  const bytes = await readFile(output)
                  verifyFfmpegBinary(bytes, target.platform, target.arch)
                }
              } finally {
                await file.close()
              }
              if (!failed) zip.readEntry()
            })().catch(fail)
          })
        })
        zip.readEntry()
      }
    )
  })
}

/** The producer emits regular USTAR-compatible records only; reject extension records and links. */
async function extractVerifiedTar(
  archive: Buffer,
  destination: string,
  target: FfmpegTarget,
  expected: Map<string, string | null>
) {
  const stream = Readable.from([archive]).pipe(createGunzip())
  const iterator = stream[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  let expanded = 0
  const take = async (length: number) => {
    const chunks: Buffer[] = []
    let count = 0
    while (count < length) {
      if (pending.length === 0) {
        const next = await iterator.next()
        if (next.done) throw new Error('Truncated FFmpeg TAR')
        pending = Buffer.from(next.value)
        expanded += pending.length
        if (expanded > MAX_EXTRACTED + 1024 * 1024)
          throw new Error('TAR expansion exceeds limits')
      }
      const size = Math.min(length - count, pending.length)
      chunks.push(pending.subarray(0, size))
      pending = pending.subarray(size)
      count += size
    }
    return Buffer.concat(chunks, length)
  }
  const octal = (field: Buffer) => {
    const text = field.toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]{1,12}$/.test(text)) throw new Error('Invalid TAR number')
    const value = Number.parseInt(text, 8)
    if (!Number.isSafeInteger(value)) throw new Error('Invalid TAR size')
    return value
  }
  const seen = new Set<string>()
  try {
    for (;;) {
      const header = await take(512)
      if (header.every((byte) => byte === 0)) {
        if (
          !(await take(512)).every((byte) => byte === 0) ||
          seen.size !== expected.size
        )
          throw new Error('Incomplete FFmpeg TAR')
        // Only zero record padding may follow the end marker; no concatenated archives.
        if (!pending.every((byte) => byte === 0))
          throw new Error('Unexpected TAR trailer')
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          expanded += next.value.length
          if (
            expanded > MAX_EXTRACTED + 1024 * 1024 ||
            !Buffer.from(next.value).every((byte) => byte === 0)
          )
            throw new Error('Unexpected TAR trailer')
        }
        break
      }
      const storedChecksum = octal(header.subarray(148, 156))
      let checksum = 0
      for (let index = 0; index < 512; index++)
        checksum += index >= 148 && index < 156 ? 32 : header[index]
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const size = octal(header.subarray(124, 136))
      const binary = name === target.binaryPath || name === target.ffprobePath
      if (
        checksum !== storedChecksum ||
        !expected.has(name) ||
        seen.has(name) ||
        ![0, 48].includes(header[156]) ||
        !header.subarray(157, 257).every((byte) => byte === 0) ||
        header.subarray(257, 263).toString('ascii') !== 'ustar\0' ||
        !header.subarray(345, 500).every((byte) => byte === 0) ||
        octal(header.subarray(100, 108)) !== (binary ? 0o755 : 0o644) ||
        size <= 0 ||
        size > (binary ? MAX_BINARY : 16 * 1024 * 1024)
      )
        throw new Error('Unsafe or unexpected FFmpeg TAR member')
      seen.add(name)
      const bytes = await take(size)
      const digest = expected.get(name)
      if (digest !== null && sha256(bytes) !== digest)
        throw new Error('FFmpeg TAR member digest mismatch')
      if (binary) verifyFfmpegBinary(bytes, target.platform, target.arch)
      const padding = await take((512 - (size % 512)) % 512)
      if (!padding.every((byte) => byte === 0))
        throw new Error('Invalid TAR padding')
      const output = path.join(destination, name)
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
    }
    const inventory = ffmpegLicenseInventorySchema.parse(
      JSON.parse(
        (await readFile(path.join(destination, 'LICENSES.json'))).toString(
          'utf8'
        )
      )
    )
    if (
      inventory.target !== target.target ||
      inventory.files.length !== target.licenseFiles.length ||
      new Set(inventory.files.map((file) => file.path)).size !==
        inventory.files.length ||
      inventory.files.some(
        (file) =>
          !target.licenseFiles.some(
            (item) => item.path === file.path && item.sha256 === file.sha256
          )
      )
    )
      throw new Error('FFmpeg license inventory mismatch')
  } finally {
    stream.destroy()
  }
}

export async function installVerifiedFfmpeg(options: {
  userDataDir: string
  arch: 'x64' | 'arm64'
  fetcher?: typeof fetch
  platform?: FfmpegPlatform
  onStatus?: (status: FfmpegInstallStatus) => void
  systemTrust?: (
    directory: string,
    target: FfmpegTarget,
    sourceUrl: string
  ) => Promise<void>
}) {
  const { userDataDir, arch } = options
  const platform = options.platform ?? 'win32'
  const root = rootFor(userDataDir)
  if (activeInstalls.has(root))
    throw new AppError(
      ErrorCode.FfmpegInstallBusy,
      'FFmpeg installation already in progress'
    )
  activeInstalls.add(root)
  let status: FfmpegInstallStatus = {
    phase: 'metadata',
    bytesReceived: 0,
    bytesTotal: 0,
    percent: null,
    releaseVersion: null,
    directory: null,
    error: null,
  }
  const publish = (patch: Partial<FfmpegInstallStatus>) => {
    status = { ...status, ...patch }
    statuses.set(root, status)
    try {
      options.onStatus?.({ ...status })
    } catch {
      /* Observers cannot alter installation state. */
    }
  }
  publish({})
  const signal = AbortSignal.timeout(10 * 60 * 1000)
  const fetcher = options.fetcher ?? fetch
  let staging: string | undefined
  let pointer: string | undefined
  try {
    assertManagedDirectory(root, true)
    assertManagedDirectory(path.join(root, 'releases'), true)
    const latestRaw = JSON.parse(
      (
        await download(
          `https://api.github.com/repos/${FFMPEG_REPOSITORY}/releases/latest`,
          1024 * 1024,
          fetcher,
          signal
        )
      ).toString('utf8')
    )
    const parsed = releaseApiSchema.safeParse(latestRaw)
    if (
      !parsed.success ||
      latestRaw.html_url !==
        `https://github.com/${FFMPEG_REPOSITORY}/releases/tag/${latestRaw.tag_name}`
    ) {
      throw new AppError(
        ErrorCode.FfmpegReleaseUnavailable,
        'No immutable formal FFmpeg release'
      )
    }
    const latest = parsed.data
    const version = ffmpegReleaseVersionSchema.parse(
      String(latest.tag_name).replace(/^v/, '')
    )
    const tag = `v${version}`
    const base = `https://github.com/${FFMPEG_REPOSITORY}/releases/download/${tag}/`
    const raw = await download(
      `${base}ffmpeg-manifest.json`,
      1024 * 1024,
      fetcher,
      signal
    )
    const sig = await download(
      `${base}ffmpeg-manifest.json.sig`,
      4096,
      fetcher,
      signal
    )
    publish({ phase: 'verifying', releaseVersion: version })
    const verified = verifyFfmpegRelease(raw, sig, arch, tag, platform)
    const assetNames = new Set(latest.assets.map((asset) => asset.name))
    if (
      assetNames.size !== latest.assets.length ||
      new Set(latest.assets.map((asset) => asset.id)).size !==
        latest.assets.length
    )
      throw new Error('Duplicate FFmpeg release assets')
    const requiredAssets = [
      { name: 'ffmpeg-manifest.json', size: raw.length },
      { name: 'ffmpeg-manifest.json.sig', size: sig.length },
      ...verified.allTargets.map((item) => ({
        name: item.archive,
        size: item.archiveSize,
      })),
    ]
    for (const required of requiredAssets) {
      const asset = latest.assets.find((item) => item.name === required.name)
      if (
        !asset ||
        asset.size !== required.size ||
        asset.browser_download_url !== `${base}${required.name}`
      )
        throw new Error('Formal FFmpeg release asset identity mismatch')
    }
    if (existsSync(path.join(root, 'current.json'))) {
      const current = readInstalled(userDataDir)
      const comparison = compareFfmpegReleases(
        version,
        current.manifest.releaseVersion
      )
      if (
        comparison < 0 ||
        (comparison === 0 && verified.manifestHash !== current.manifestHash)
      ) {
        throw new Error('FFmpeg release rollback or same-version substitution')
      }
    }
    assertManagedDirectory(
      path.join(
        root,
        'releases',
        `${verified.manifestHash}-${platform}-${arch}`
      ),
      true
    )
    await ensureManagedDirectory(root)
    await ensureManagedDirectory(path.join(root, 'releases'))
    publish({
      phase: 'downloading',
      bytesTotal: verified.target.archiveSize,
      percent: 0,
    })
    const archive = await download(
      `${base}${verified.target.archive}`,
      verified.target.archiveSize,
      fetcher,
      signal,
      (received) =>
        publish({
          bytesReceived: received,
          bytesTotal: verified.target.archiveSize,
          percent: Math.min(1, received / verified.target.archiveSize),
        })
    )
    staging = await mkdtemp(path.join(root, '.install-'))
    publish({ phase: 'extracting', percent: null })
    await extractVerifiedFfmpeg(archive, staging, verified.target)
    await markWindowsInternetOrigin(
      staging,
      verified.target,
      `${base}${verified.target.archive}`
    )
    if (platform !== 'win32') {
      for (const name of [
        verified.target.binaryPath,
        verified.target.ffprobePath,
      ])
        await chmod(path.join(staging, name), 0o700)
    }
    if (platform === 'darwin') {
      publish({ phase: 'systemTrust' })
      if (!options.systemTrust)
        throw new Error('macOS system trust verifier is required')
      await options.systemTrust(
        staging,
        verified.target,
        `${base}${verified.target.archive}`
      )
    }
    hashBinary(
      path.join(staging, verified.target.binaryPath),
      verified.target.binarySha256,
      arch,
      platform
    )
    hashBinary(
      path.join(staging, verified.target.ffprobePath),
      verified.target.ffprobeSha256,
      arch,
      platform
    )
    await writeFile(path.join(staging, 'ffmpeg-manifest.json'), raw, {
      flag: 'wx',
      mode: 0o600,
    })
    await writeFile(path.join(staging, 'ffmpeg-manifest.json.sig'), sig, {
      flag: 'wx',
      mode: 0o600,
    })
    const directory = path.join(
      root,
      'releases',
      `${verified.manifestHash}-${platform}-${arch}`
    )
    publish({ phase: 'installing' })
    if (existsSync(directory)) {
      assertManagedDirectory(directory)
      if (
        !regularBytes(
          path.join(directory, 'ffmpeg-manifest.json'),
          1024 * 1024
        ).equals(raw) ||
        !regularBytes(
          path.join(directory, 'ffmpeg-manifest.json.sig'),
          4096
        ).equals(sig)
      ) {
        throw new Error('Existing FFmpeg version directory conflicts')
      }
      hashBinary(
        path.join(directory, verified.target.binaryPath),
        verified.target.binarySha256,
        arch,
        platform
      )
      hashBinary(
        path.join(directory, verified.target.ffprobePath),
        verified.target.ffprobeSha256,
        arch,
        platform
      )
      // Reusing an identical version never drops the Internet-origin treatment.
      await markWindowsInternetOrigin(
        directory,
        verified.target,
        `${base}${verified.target.archive}`
      )
      if (platform === 'darwin') {
        publish({ phase: 'systemTrust' })
        if (!options.systemTrust)
          throw new Error('macOS system trust verifier is required')
        await options.systemTrust(
          directory,
          verified.target,
          `${base}${verified.target.archive}`
        )
        publish({ phase: 'installing' })
      }
    } else {
      await rename(staging, directory)
      staging = undefined
    }
    pointer = path.join(root, `.current-${randomUUID()}.json`)
    signal.throwIfAborted()
    const pointerFile = await open(pointer, 'wx', 0o600)
    try {
      await pointerFile.writeFile(
        JSON.stringify({
          manifestHash: verified.manifestHash,
          releaseVersion: version,
          arch,
          platform,
          layoutVersion: 2,
        })
      )
      await pointerFile.sync()
    } finally {
      await pointerFile.close()
    }
    await rename(pointer, path.join(root, 'current.json'))
    pointer = undefined
    publish({ phase: 'installed', directory, percent: 1 })
    return { ok: true as const, releaseVersion: version }
  } catch (error) {
    const code =
      error instanceof AppError &&
      error.code === ErrorCode.FfmpegReleaseUnavailable
        ? 'unavailable'
        : (error instanceof AppError &&
              error.code === ErrorCode.FfmpegInstallFailed) ||
            (error instanceof Error &&
              fileSystemErrorCodes.has(
                (error as NodeJS.ErrnoException).code ?? ''
              ))
          ? 'install'
          : status.phase === 'metadata' || status.phase === 'downloading'
            ? 'download'
            : status.phase === 'systemTrust'
              ? 'systemTrust'
              : status.phase === 'installing'
                ? 'install'
                : 'verification'
    publish({ phase: 'failed', error: code, percent: null })
    throw new AppError(
      ErrorCode.FfmpegInstallFailed,
      'FFmpeg installation failed',
      error
    )
  } finally {
    if (staging)
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (pointer) await rm(pointer, { force: true }).catch(() => {})
    activeInstalls.delete(root)
  }
}
