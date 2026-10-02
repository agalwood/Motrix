// @vitest-environment node
import { sign } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import certificate from '@shared/config/ffmpeg-macos-certificate.json'
import {
  FFMPEG_SIGNATURE_DOMAIN,
  FFMPEG_WINDOWS_LICENSE,
  type FfmpegPlatform,
} from '@shared/schemas/ffmpeg-release'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertManagedFfmpegTrusted,
  extractVerifiedFfmpeg,
  getFfmpegInstallStatus,
  installVerifiedFfmpeg,
  resolveManagedFfmpegCandidate,
} from './verified-install'
import {
  compareFfmpegReleases,
  sha256,
  verifyFfmpegRelease,
} from './verified-release'

// A distinct, ephemeral test root. Production private keys never enter fixtures.
const testKeys = await vi.hoisted(async () => {
  const crypto = await import('node:crypto')
  const pair = crypto.generateKeyPairSync('ed25519')
  const der = pair.publicKey.export({ type: 'spki', format: 'der' })
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    keyId: `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`,
  }
})
vi.mock('@shared/config/ffmpeg-release-key.json', () => ({ default: testKeys }))

function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(
  entries: Array<{
    name: string
    data: Buffer
    mode?: number
    declaredSize?: number
  }>
) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(entry.data), 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.declaredSize ?? entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(0x0314, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc32(entry.data), 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((entry.mode ?? 0x81a4) * 65536) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    local.push(header, name, entry.data)
    central.push(record, name)
    offset += header.length + name.length + entry.data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(Buffer.concat(central).length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}
function pe(arch: 'x64' | 'arm64') {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.writeUInt32LE(0x00004550, 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  bytes.writeUInt16LE(240, 84)
  bytes.writeUInt16LE(0x20b, 88)
  return bytes
}
function nativeBinary(platform: FfmpegPlatform, arch: 'x64' | 'arm64') {
  if (platform === 'win32') return pe(arch)
  const bytes = Buffer.alloc(512)
  if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    bytes.writeUInt32LE(2, 12)
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes)
    bytes.writeUInt16LE(2, 16)
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  }
  return bytes
}
function tar(
  entries: Array<{ name: string; data: Buffer; type?: string; mode?: number }>
) {
  const records: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100)
    const number = (value: number, offset: number, size: number) =>
      header.write(value.toString(8).padStart(size - 1, '0'), offset, size - 1)
    number(
      entry.mode ??
        (entry.name === 'ffmpeg' || entry.name === 'ffprobe' ? 0o755 : 0o644),
      100,
      8
    )
    number(0, 108, 8)
    number(0, 116, 8)
    number(entry.data.length, 124, 12)
    number(0, 136, 12)
    header.fill(32, 148, 156)
    header.write(entry.type ?? '0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    number(
      header.reduce((sum, byte) => sum + byte, 0),
      148,
      7
    )
    header[155] = 32
    records.push(
      header,
      entry.data,
      Buffer.alloc((512 - (entry.data.length % 512)) % 512)
    )
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}
function fixture(
  version = '9.0.2-motrix.8',
  arch: 'x64' | 'arm64' = 'x64',
  platform: FfmpegPlatform = 'win32',
  additionalManifest: Record<string, unknown> = {}
) {
  const licenseFiles = [
    { path: 'LICENSES/GPL.txt', sha256: sha256(Buffer.from('license')) },
  ]
  const inventory = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      target: `${platform}-${arch}`,
      files: licenseFiles,
    })
  )
  const files = new Map([
    [
      platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      nativeBinary(platform, arch),
    ],
    [
      platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      nativeBinary(platform, arch),
    ],
    ['BUILD-INFO.json', Buffer.from('{}')],
    ['LICENSES.json', inventory],
    ['configure.txt', Buffer.from('--enable-gpl')],
    ['README.txt', Buffer.from('readme')],
    ['LICENSES/GPL.txt', Buffer.from('license')],
  ])
  const entries = [...files].map(([name, data]) => ({ name, data }))
  const archive = platform === 'linux' ? tar(entries) : zip(entries)
  const target = {
    schemaVersion: 2 as const,
    releaseVersion: version,
    target: `${platform}-${arch}`,
    platform,
    arch,
    minimumOs: {
      name: { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform],
      version:
        platform === 'darwin' ? '12.0' : platform === 'win32' ? '10.0' : '4.18',
    },
    license:
      platform === 'win32'
        ? FFMPEG_WINDOWS_LICENSE
        : FFMPEG_WINDOWS_LICENSE.split(' AND (Apache-2.0')[0] +
          (platform === 'linux'
            ? ' AND 0BSD AND SunPro AND (GPL-3.0-or-later WITH GCC-exception-3.1)'
            : ''),
    archive: `ffmpeg-${version}-${platform}-${arch}.${platform === 'linux' ? 'tar.gz' : 'zip'}`,
    archiveSha256: sha256(archive),
    archiveSize: archive.length,
    binaryPath:
      platform === 'win32' ? ('ffmpeg.exe' as const) : ('ffmpeg' as const),
    binarySha256: sha256(nativeBinary(platform, arch)),
    ffprobePath:
      platform === 'win32' ? ('ffprobe.exe' as const) : ('ffprobe' as const),
    ffprobeSha256: sha256(nativeBinary(platform, arch)),
    buildInfoSha256: sha256(Buffer.from('{}')),
    configureSha256: sha256(Buffer.from('--enable-gpl')),
    licensesSha256: sha256(inventory),
    signing: null,
    signingEvidenceSha256: null,
    licenseFiles,
  }
  const metadataFor = (name: string) => {
    if (name === target.target) return target
    const [otherPlatform, otherArch] = name.split('-') as [
      FfmpegPlatform,
      'x64' | 'arm64',
    ]
    return {
      ...target,
      target: name,
      platform: otherPlatform,
      arch: otherArch,
      archive: `ffmpeg-${version}-${name}.${otherPlatform === 'linux' ? 'tar.gz' : 'zip'}`,
      binaryPath: otherPlatform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      ffprobePath: otherPlatform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      binarySha256: sha256(nativeBinary(otherPlatform, otherArch)),
      ffprobeSha256: sha256(nativeBinary(otherPlatform, otherArch)),
      minimumOs: {
        name: { darwin: 'macos', win32: 'windows', linux: 'linux' }[
          otherPlatform
        ],
        version:
          otherPlatform === 'darwin'
            ? '12.0'
            : otherPlatform === 'win32'
              ? '10.0'
              : '4.18',
      },
      license:
        otherPlatform === 'win32'
          ? FFMPEG_WINDOWS_LICENSE
          : FFMPEG_WINDOWS_LICENSE.split(' AND (Apache-2.0')[0] +
            (otherPlatform === 'linux'
              ? ' AND 0BSD AND SunPro AND (GPL-3.0-or-later WITH GCC-exception-3.1)'
              : ''),
    }
  }
  const allTargets = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ]
    .map(metadataFor)
    .map((item) => {
      if (item.platform !== 'darwin') return item
      return {
        ...item,
        signingEvidenceSha256: 'a'.repeat(64),
        signing: {
          schemaVersion: 3,
          target: item.target,
          platform: 'darwin',
          kind: 'apple-developer-id',
          identity: {
            teamId: 'TESTTEAM01',
            subject: 'Developer ID Application: Test (TESTTEAM01)',
            certificateSha256: certificate.certificateSha256,
          },
          binaries: Object.fromEntries(
            ['ffmpeg', 'ffprobe'].map((name) => [
              name,
              {
                sha256: item.binarySha256,
                cdHash: 'a'.repeat(40),
                timestamp: '2026-09-30T12:00:00Z',
                hardenedRuntime: true,
              },
            ])
          ),
          notarization: {
            submissionId: '00000000-0000-4000-8000-000000000000',
            status: 'Accepted',
            submissionResultSha256: 'a'.repeat(64),
            developerLog: {
              name: `ffmpeg-${version}-${item.target}.notarization-log.json`,
              sha256: 'a'.repeat(64),
              size: 10,
            },
          },
        },
      }
    })
  const selected = allTargets.find((item) => item.target === target.target)!
  const manifest = {
    schemaVersion: 3,
    repository: 'motrixapp/ffmpeg-static',
    windowsTrust: 'motrix-ed25519',
    formalRelease: true,
    releaseVersion: version,
    releaseTag: `v${version}`,
    releaseCommit: 'a'.repeat(40),
    controlCommit: 'a'.repeat(40),
    profile: 'motrix-full-gpl',
    targets: allTargets,
    ...additionalManifest,
  }
  const raw = Buffer.from(JSON.stringify(manifest))
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(FFMPEG_SIGNATURE_DOMAIN), raw]),
    testKeys.privateKey
  )
  const envelope = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: testKeys.keyId,
      signature: signature.toString('base64'),
    })
  )
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/latest'))
      return new Response(
        JSON.stringify({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          immutable: true,
          published_at: '2026-10-01T01:00:00Z',
          html_url: `https://github.com/motrixapp/ffmpeg-static/releases/tag/v${version}`,
          assets: [
            { name: 'ffmpeg-manifest.json', size: raw.length },
            { name: 'ffmpeg-manifest.json.sig', size: envelope.length },
            ...allTargets.map((item) => ({
              name: item.archive,
              size: item.archiveSize,
            })),
          ].map((item, index) => ({
            ...item,
            id: index + 1,
            state: 'uploaded',
            browser_download_url: `https://github.com/motrixapp/ffmpeg-static/releases/download/v${version}/${item.name}`,
          })),
        })
      )
    if (url.endsWith('.json.sig')) return new Response(envelope)
    if (url.endsWith('ffmpeg-manifest.json')) return new Response(raw)
    if (url.endsWith(target.archive)) return new Response(archive)
    throw new Error('Unexpected URL')
  })
  return {
    raw,
    envelope,
    archive,
    target: selected as import('@shared/schemas/ffmpeg-release').FfmpegTarget,
    entries,
    fetcher,
  }
}
const directories: string[] = []
async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motrix-ffmpeg-test-'))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('verified FFmpeg releases', () => {
  it('creates the missing binaries directory and keeps the verified installation inside it', async () => {
    const userDataDir = await temp()
    const binaries = path.join(userDataDir, 'binaries')
    await expect(lstat(binaries)).rejects.toMatchObject({ code: 'ENOENT' })
    const release = fixture()
    await installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: release.fetcher,
    })
    const info = await lstat(binaries)
    expect(info.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
    expect(await readdir(userDataDir)).toEqual(['binaries'])
    expect(await readdir(binaries)).toEqual(['ffmpeg-verified'])
    expect(getFfmpegInstallStatus(userDataDir).directory).toBe(
      path.join(
        binaries,
        'ffmpeg-verified',
        'releases',
        `${sha256(release.raw)}-win32-x64`
      )
    )
  })
  it('preserves existing manual tools when creating the verified installation beside them', async () => {
    const userDataDir = await temp()
    const binaries = path.join(userDataDir, 'binaries')
    await mkdir(binaries, { mode: 0o755 })
    const names = [
      'ffmpeg',
      'ffprobe',
      'ffmpeg.exe',
      'ffprobe.exe',
      'other-tool',
    ]
    for (const name of names) {
      await writeFile(path.join(binaries, name), `manual ${name}`)
    }
    const release = fixture()
    await installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: release.fetcher,
    })
    for (const name of names) {
      expect(await readFile(path.join(binaries, name), 'utf8')).toBe(
        `manual ${name}`
      )
    }
    expect((await readdir(binaries)).sort()).toEqual(
      [...names, 'ffmpeg-verified'].sort()
    )
  })
  it.each(['binaries', 'root', 'releases', 'version'])(
    'rejects a managed %s directory symlink before creating or writing its target',
    async (component) => {
      const userDataDir = await temp()
      const outside = await temp()
      const release = fixture()
      const binaries = path.join(userDataDir, 'binaries')
      const root = path.join(userDataDir, 'binaries', 'ffmpeg-verified')
      let linkPath = binaries
      if (component !== 'binaries') {
        await mkdir(binaries, { mode: 0o700 })
        linkPath = root
      }
      if (component === 'releases' || component === 'version') {
        await mkdir(root, { mode: 0o700 })
        linkPath = path.join(root, 'releases')
      }
      if (component === 'version') {
        await mkdir(linkPath, { mode: 0o700 })
        linkPath = path.join(linkPath, `${sha256(release.raw)}-win32-x64`)
      }
      await symlink(
        outside,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await expect(
        installVerifiedFfmpeg({
          userDataDir,
          arch: 'x64',
          fetcher: release.fetcher,
        })
      ).rejects.toThrow()
      expect(await readdir(outside)).toEqual([])
      expect(getFfmpegInstallStatus(userDataDir).error).toBe('install')
      if (component !== 'version')
        expect(release.fetcher).not.toHaveBeenCalled()
      else
        expect(
          release.fetcher.mock.calls.some(([url]) =>
            String(url).endsWith(release.target.archive)
          )
        ).toBe(false)
    }
  )
  it.each(['binaries', 'ffmpeg-verified'])(
    'reports a non-directory %s as an install error before downloading',
    async (component) => {
      const userDataDir = await temp()
      const binaries = path.join(userDataDir, 'binaries')
      if (component !== 'binaries') await mkdir(binaries, { mode: 0o700 })
      await writeFile(
        component === 'binaries'
          ? binaries
          : path.join(binaries, 'ffmpeg-verified'),
        'not a directory'
      )
      const fetcher = fixture().fetcher
      await expect(
        installVerifiedFfmpeg({ userDataDir, arch: 'x64', fetcher })
      ).rejects.toThrow()
      expect(getFfmpegInstallStatus(userDataDir).error).toBe('install')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.skipIf(process.platform === 'win32')(
    'rejects a group- or world-writable binaries directory before downloading',
    async () => {
      const userDataDir = await temp()
      const binaries = path.join(userDataDir, 'binaries')
      await mkdir(binaries)
      const fetcher = fixture().fetcher
      for (const mode of [0o770, 0o707]) {
        await chmod(binaries, mode)
        await expect(
          installVerifiedFfmpeg({ userDataDir, arch: 'x64', fetcher })
        ).rejects.toThrow()
        expect(getFfmpegInstallStatus(userDataDir).error).toBe('install')
        expect(await readdir(binaries)).toEqual([])
      }
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it('rejects a binaries parent replaced with a link before resolving or trusting installed code', async () => {
    const userDataDir = await temp()
    const release = fixture()
    await installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: release.fetcher,
    })
    const binaries = path.join(userDataDir, 'binaries')
    const candidate = path.join(binaries, 'ffmpeg.exe')
    const binary = resolveManagedFfmpegCandidate(
      userDataDir,
      candidate,
      'win32'
    )
    const moved = path.join(userDataDir, 'moved-binaries')
    await rename(binaries, moved)
    await symlink(
      moved,
      binaries,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(() => assertManagedFfmpegTrusted(userDataDir, binary)).toThrow(
      'Invalid managed FFmpeg directory'
    )
    expect(() =>
      resolveManagedFfmpegCandidate(userDataDir, candidate, 'win32')
    ).toThrow('Invalid managed FFmpeg directory')
    release.fetcher.mockClear()
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
      })
    ).rejects.toThrow()
    expect(release.fetcher).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32')(
    'rechecks binaries parent permissions before trusting a cached managed binary',
    async () => {
      const userDataDir = await temp()
      const release = fixture()
      await installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
      })
      const binaries = path.join(userDataDir, 'binaries')
      const binary = resolveManagedFfmpegCandidate(
        userDataDir,
        path.join(binaries, 'ffmpeg.exe'),
        'win32'
      )
      await chmod(binaries, 0o777)
      expect(() => assertManagedFfmpegTrusted(userDataDir, binary)).toThrow(
        'Invalid managed FFmpeg directory'
      )
    }
  )
  it('rejects a signed same-version replacement and tampered reused files without changing the pointer', async () => {
    const userDataDir = await temp()
    const release = fixture()
    await installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: release.fetcher,
    })
    const pointer = path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'current.json'
    )
    const before = await readFile(pointer)
    const replacement = fixture(undefined, 'x64', 'win32', {
      extra: 'same version substitution',
    })
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: replacement.fetcher,
      })
    ).rejects.toThrow()
    expect(await readFile(pointer)).toEqual(before)
    const directory =
      getFfmpegInstallStatus(userDataDir).directory ??
      path.join(
        userDataDir,
        'binaries',
        'ffmpeg-verified',
        'releases',
        `${sha256(release.raw)}-win32-x64`
      )
    await writeFile(path.join(directory, 'ffprobe.exe'), 'tampered')
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
      })
    ).rejects.toThrow()
    expect(await readFile(pointer)).toEqual(before)
  })
  it.each([
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ] as const)(
    'installs %s-%s without executing payloads and emits bounded phase progress',
    async (platform, arch) => {
      const userDataDir = await temp()
      const release = fixture(undefined, arch, platform)
      const systemTrust = vi.fn(async () => {})
      const onStatus = vi.fn()
      await installVerifiedFfmpeg({
        userDataDir,
        platform,
        arch,
        fetcher: release.fetcher,
        systemTrust,
        onStatus,
      })
      const binary = resolveManagedFfmpegCandidate(
        userDataDir,
        path.join(userDataDir, 'binaries', 'ffmpeg'),
        platform
      )
      assertManagedFfmpegTrusted(userDataDir, binary)
      expect(getFfmpegInstallStatus(userDataDir)).toMatchObject({
        phase: 'installed',
        directory: path.dirname(binary),
      })
      const phases = onStatus.mock.calls.map(([status]) => status.phase)
      expect(phases).toContain('downloading')
      expect(phases).toContain('extracting')
      expect(phases.at(-1)).toBe('installed')
      expect(systemTrust).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0)
    }
  )
  it('requires macOS system trust and preserves the old version on rejection', async () => {
    const userDataDir = await temp()
    const original = fixture(undefined, 'arm64', 'darwin')
    await installVerifiedFfmpeg({
      userDataDir,
      platform: 'darwin',
      arch: 'arm64',
      fetcher: original.fetcher,
      systemTrust: async () => {},
    })
    const pointer = path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'current.json'
    )
    const before = await readFile(pointer)
    const next = fixture('9.0.2-motrix.9', 'arm64', 'darwin')
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        platform: 'darwin',
        arch: 'arm64',
        fetcher: next.fetcher,
      })
    ).rejects.toThrow()
    expect(getFfmpegInstallStatus(userDataDir).error).toBe('systemTrust')
    expect(await readFile(pointer)).toEqual(before)
  })
  it('rechecks the actual reused macOS directory and keeps its pointer on trust rejection', async () => {
    const userDataDir = await temp()
    const release = fixture(undefined, 'arm64', 'darwin')
    const firstTrust = vi.fn(async () => {})
    await installVerifiedFfmpeg({
      userDataDir,
      platform: 'darwin',
      arch: 'arm64',
      fetcher: release.fetcher,
      systemTrust: firstTrust,
    })
    const installedDirectory = getFfmpegInstallStatus(userDataDir).directory
    const pointer = path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'current.json'
    )
    const before = await readFile(pointer)
    const reusedTrust = vi.fn(async (directory: string) => {
      if (directory === installedDirectory)
        throw new Error('reused directory no longer passes Gatekeeper')
    })
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        platform: 'darwin',
        arch: 'arm64',
        fetcher: release.fetcher,
        systemTrust: reusedTrust,
      })
    ).rejects.toThrow()
    expect(reusedTrust).toHaveBeenCalledTimes(2)
    expect(reusedTrust.mock.calls[0][0]).not.toBe(installedDirectory)
    expect(reusedTrust.mock.calls[1][0]).toBe(installedDirectory)
    expect(getFfmpegInstallStatus(userDataDir).error).toBe('systemTrust')
    expect(await readFile(pointer)).toEqual(before)
  })
  it('does not let a failing progress observer change the atomic installation outcome', async () => {
    const userDataDir = await temp()
    const release = fixture()
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
        onStatus: () => {
          throw new Error('observer failed')
        },
      })
    ).resolves.toMatchObject({ ok: true })
    expect(getFfmpegInstallStatus(userDataDir).phase).toBe('installed')
  })
  it.each([
    'draft',
    'prerelease',
    'mutable',
    'wrong-repo',
    'missing-asset',
    'wrong-size',
    'wrong-url',
    'duplicate-asset',
  ])('rejects %s Release metadata before installing', async (kind) => {
    const userDataDir = await temp()
    const release = fixture()
    const fetcher = release.fetcher.getMockImplementation()!
    release.fetcher.mockImplementation(async (...args) => {
      const response = await fetcher(...args)
      if (!String(args[0]).endsWith('/latest')) return response
      const meta = await response.json()
      if (kind === 'draft') meta.draft = true
      if (kind === 'prerelease') meta.prerelease = true
      if (kind === 'mutable') meta.immutable = false
      if (kind === 'wrong-repo')
        meta.html_url = meta.html_url.replace('motrixapp/', 'evil/')
      if (kind === 'missing-asset') meta.assets.pop()
      if (kind === 'wrong-size') meta.assets[0].size++
      if (kind === 'wrong-url')
        meta.assets[0].browser_download_url = 'https://evil.test/manifest'
      if (kind === 'duplicate-asset') meta.assets.push(meta.assets[0])
      return new Response(JSON.stringify(meta))
    })
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
      })
    ).rejects.toThrow()
    expect(getFfmpegInstallStatus(userDataDir).phase).toBe('failed')
  })
  it('rejects missing formal Releases, concurrent installs, and oversized streaming responses', async () => {
    const userDataDir = await temp()
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: vi.fn(async () => new Response(null, { status: 404 })),
      })
    ).rejects.toThrow()
    expect(getFfmpegInstallStatus(userDataDir).error).toBe('unavailable')
    let releaseResponse!: (value: Response) => void
    const waiting = installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseResponse = resolve
          })
      ),
    })
    await expect(
      installVerifiedFfmpeg({ userDataDir, arch: 'x64' })
    ).rejects.toThrow('already in progress')
    releaseResponse(new Response('x'.repeat(1024 * 1024 + 1)))
    await expect(waiting).rejects.toThrow()
  })
  it.each(['symlink', 'hardlink'])(
    'rejects installed binary %s substitution before execution',
    async (kind) => {
      const userDataDir = await temp()
      const release = fixture()
      await installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: release.fetcher,
      })
      const binary = resolveManagedFfmpegCandidate(
        userDataDir,
        path.join(userDataDir, 'binaries', 'ffmpeg.exe'),
        'win32'
      )
      const elsewhere = path.join(userDataDir, 'elsewhere')
      await writeFile(elsewhere, pe('x64'))
      await rm(binary)
      if (kind === 'symlink') await symlink(elsewhere, binary)
      else await link(elsewhere, binary)
      expect(() => assertManagedFfmpegTrusted(userDataDir, binary)).toThrow()
    }
  )
  it.each([
    'traversal',
    'symlink',
    'hardlink',
    'device',
    'pax',
    'duplicate',
    'case',
    'wrong-arch',
    'trailer',
  ])('rejects authenticated TAR %s violations', async (kind) => {
    const release = fixture(undefined, 'x64', 'linux')
    const entries: Array<{ name: string; data: Buffer; type?: string }> = [
      ...release.entries,
    ]
    if (kind === 'traversal') entries[0] = { ...entries[0], name: '../ffmpeg' }
    if (kind === 'symlink') entries[0] = { ...entries[0], type: '2' }
    if (kind === 'hardlink') entries[0] = { ...entries[0], type: '1' }
    if (kind === 'device') entries[0] = { ...entries[0], type: '3' }
    if (kind === 'pax') entries[0] = { ...entries[0], type: 'x' }
    if (kind === 'duplicate') entries.push(entries[0])
    if (kind === 'case') entries[0] = { ...entries[0], name: 'FFMPEG' }
    if (kind === 'wrong-arch')
      entries[0] = { ...entries[0], data: nativeBinary('linux', 'arm64') }
    let archive = tar(entries)
    if (kind === 'trailer')
      archive = Buffer.concat([archive, gzipSync(Buffer.from('evil'))])
    const target = {
      ...release.target,
      archiveSize: archive.length,
      archiveSha256: sha256(archive),
    }
    await expect(
      extractVerifiedFfmpeg(archive, await temp(), target)
    ).rejects.toThrow()
  })
  it.each(['x64', 'arm64'] as const)(
    'installs and verifies %s without executing payloads',
    async (arch) => {
      const userDataDir = await temp()
      const release = fixture(undefined, arch)
      await expect(
        installVerifiedFfmpeg({ userDataDir, arch, fetcher: release.fetcher })
      ).resolves.toEqual({ ok: true, releaseVersion: '9.0.2-motrix.8' })
      const binary = resolveManagedFfmpegCandidate(
        userDataDir,
        path.join(userDataDir, 'binaries', 'ffmpeg.exe'),
        'win32'
      )
      expect(binary).toContain(sha256(release.raw))
      assertManagedFfmpegTrusted(userDataDir, binary)
      await writeFile(binary, Buffer.from('tampered'))
      expect(() => assertManagedFfmpegTrusted(userDataDir, binary)).toThrow()
    }
  )
  it('rejects altered raw bytes, missing signatures, unknown keys and replayed tag identities', () => {
    const release = fixture()
    expect(() =>
      verifyFfmpegRelease(
        Buffer.concat([release.raw, Buffer.from(' ')]),
        release.envelope,
        'x64'
      )
    ).toThrow()
    expect(() =>
      verifyFfmpegRelease(release.raw, Buffer.from('{}'), 'x64')
    ).toThrow()
    expect(() =>
      verifyFfmpegRelease(release.raw, release.envelope.subarray(0, -1), 'x64')
    ).toThrow()
    expect(() =>
      verifyFfmpegRelease(release.raw.subarray(0, -1), release.envelope, 'x64')
    ).toThrow('signature')
    const wrongKey = Buffer.from(
      release.envelope
        .toString()
        .replace(testKeys.keyId, `sha256:${'0'.repeat(64)}`)
    )
    expect(() => verifyFfmpegRelease(release.raw, wrongKey, 'x64')).toThrow()
    expect(() =>
      verifyFfmpegRelease(
        release.raw,
        release.envelope,
        'x64',
        'v9.0.3-motrix.2'
      )
    ).toThrow()
  })
  it('compares revision numerically and rejects below-floor releases', () => {
    expect(compareFfmpegReleases('9.0.1-motrix.10', '9.0.1-motrix.2')).toBe(1)
    const old = fixture('9.0.1-motrix.1')
    expect(() => verifyFfmpegRelease(old.raw, old.envelope, 'x64')).toThrow()
  })
  it('retains last-good pointer after a failed download and prevents signed rollback', async () => {
    const userDataDir = await temp()
    const newer = fixture('9.0.3-motrix.2')
    await installVerifiedFfmpeg({
      userDataDir,
      arch: 'x64',
      fetcher: newer.fetcher,
    })
    const pointer = path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'current.json'
    )
    const before = await readFile(pointer)
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: fixture().fetcher,
      })
    ).rejects.toThrow('installation failed')
    expect((await readFile(pointer)).equals(before)).toBe(true)
    const broken = fixture('9.0.4-motrix.2')
    broken.fetcher.mockImplementation(
      async () => new Response('oops', { status: 503 })
    )
    await expect(
      installVerifiedFfmpeg({
        userDataDir,
        arch: 'x64',
        fetcher: broken.fetcher,
      })
    ).rejects.toThrow()
    expect((await readFile(pointer)).equals(before)).toBe(true)
  })
  it('rejects untrusted redirects without following them', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://localhost/private' },
        })
    )
    await expect(
      installVerifiedFfmpeg({ userDataDir: await temp(), arch: 'x64', fetcher })
    ).rejects.toThrow('installation failed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    'traversal',
    'duplicate',
    'case',
    'symlink',
    'wrong-arch',
    'extra',
    'missing',
    'size',
    'expansion',
  ])('rejects a signed ZIP with %s violation', async (kind) => {
    const release = fixture()
    const entries = [...release.entries]
    if (kind === 'traversal')
      entries.push({ name: '../escape.exe', data: pe('x64') })
    if (kind === 'duplicate') entries.push(entries[0])
    if (kind === 'case') entries.push({ name: 'FFMPEG.EXE', data: pe('x64') })
    if (kind === 'symlink')
      entries[0] = { ...entries[0], mode: 0xa1ff } as (typeof entries)[0]
    if (kind === 'extra') entries.push({ name: 'evil.dll', data: pe('x64') })
    if (kind === 'missing') entries.pop()
    if (kind === 'size')
      entries[0] = {
        ...entries[0],
        declaredSize: 257 * 1024 * 1024,
      } as (typeof entries)[0]
    if (kind === 'expansion')
      entries[0] = { ...entries[0], declaredSize: 8 } as (typeof entries)[0]
    if (kind === 'wrong-arch') {
      entries[0] = { ...entries[0], data: pe('arm64') }
      release.target.binarySha256 = sha256(entries[0].data)
    }
    const archive = zip(entries)
    const target = {
      ...release.target,
      archiveSize: archive.length,
      archiveSha256: sha256(archive),
    }
    await expect(
      extractVerifiedFfmpeg(archive, await temp(), target)
    ).rejects.toThrow()
  })
  it('leaves explicitly user-managed installations outside project trust policy', async () => {
    const userDataDir = await temp()
    const external = path.join(userDataDir, 'external', 'ffmpeg.exe')
    expect(resolveManagedFfmpegCandidate(userDataDir, external)).toBe(external)
  })
})
