import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  createSigningArchive,
  SIGNING_ARCHIVE_LIMITS,
  verifySigningInput,
} from '../../scripts/release-signing-input.mjs'

const ROOT = process.cwd()
const COMMIT = 'a'.repeat(40)
const temporaryDirectories: string[] = []
const TRUSTED_FIXTURES = [
  ['electron-builder.signing.json', 'electron-builder.signing.json'],
  ['build/256x256.png', 'signing-build-resources/256x256.png'],
  ['build/background.tiff', 'signing-build-resources/background.tiff'],
  [
    'build/entitlements.mac.plist',
    'signing-build-resources/entitlements.mac.plist',
  ],
  ['build/icon.icns', 'signing-build-resources/icon.icns'],
  ['build/icon.ico', 'signing-build-resources/icon.ico'],
  ['build/torrent.icns', 'signing-build-resources/torrent.icns'],
  ['build/torrent.ico', 'signing-build-resources/torrent.ico'],
  ['build/installer.nsh', 'signing-policy/installer.nsh'],
  ['scripts/release-signing-tool/package.json', 'signing-tool/package.json'],
  [
    'scripts/release-signing-tool/package-lock.json',
    'signing-tool/package-lock.json',
  ],
  ['scripts/release-signing-input.mjs', 'scripts/release-signing-input.mjs'],
  [
    'scripts/electron-package-size-budgets.json',
    'scripts/electron-package-size-budgets.json',
  ],
  ['scripts/electron-package-utils.mjs', 'scripts/electron-package-utils.mjs'],
  ['scripts/native-binary-target.mjs', 'scripts/native-binary-target.mjs'],
  [
    'scripts/verify-electron-package.mjs',
    'scripts/verify-electron-package.mjs',
  ],
] as const

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('isolated release signing input', () => {
  it('accepts a digest-complete data-only fixture', async () => {
    const directory = await createFixture()

    await expect(verify(directory)).resolves.toMatchObject({
      commit: COMMIT,
      target: { key: 'win32-x64', platform: 'win32', arch: 'x64' },
      tools: { electronBuilder: '26.15.7', electron: '43.4.0' },
      limits: SIGNING_ARCHIVE_LIMITS,
    })
  })

  it.each([
    'trusted/electron.zip',
    'release/preseeded.exe',
    'package.json',
    'electron-builder.env',
    'dist/electron-app/electron-builder.env',
    'dist/electron-app/ELECTRON-BUILDER.ENV',
    'dist/electron-app/Package-Lock.json',
    'dist/electron-app/pnpm-lock.yaml',
    'dist/electron-app/yarn.lock',
    'dist/electron-app/bun.lockb',
    'dist/electron-app/.npmrc',
    'dist/electron-app/.yarn/cache/package.zip',
    'unreviewed-root-file.json',
    'signing-build-resources/installer.nsi',
    'signing-build-resources/installer.nsh',
    'signing-build-resources/messages.yml',
    'signing-build-resources/x86-unicode/plugin.dll',
    'signing-build-resources/x86-ansi/plugin.dll',
  ])('rejects reserved signing input path %s', async (reservedPath) => {
    const directory = await createFixture({
      files: [[reservedPath, 'untrusted']],
    })

    await expect(verify(directory)).rejects.toThrow(
      /invalid file entry|reserved file|reserved directory/
    )
  })

  it.each(['trusted', 'release'])(
    'rejects an empty reserved directory %s',
    async (reservedPath) => {
      const directory = await createFixture()
      await mkdir(path.join(directory, reservedPath))

      await expect(verify(directory)).rejects.toThrow(/reserved directory/)
    }
  )

  it('rejects a trusted config whose digest changed', async () => {
    const directory = await createFixture({
      mutateConfig: (config) => {
        config.beforePack = './untrusted.mjs'
      },
    })

    await expect(verify(directory)).rejects.toThrow(
      /trusted signing input digest mismatch/
    )
  })

  it('rejects a signing lock redirected away from the npm registry', async () => {
    const directory = await createFixture({
      mutateLock: (lock) => {
        const packages = lock.packages as Record<
          string,
          Record<string, unknown>
        >
        packages['node_modules/electron-builder']!.resolved =
          'https://example.invalid/electron-builder.tgz'
      },
    })

    await expect(verify(directory)).rejects.toThrow(
      /trusted signing input digest mismatch/
    )
  })

  it('writes a deterministic bounded tar with manifest file modes', async () => {
    const directory = await createFixture()
    const executable = path.join(directory, 'extra/win32/x64/aria2c.exe')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, 'binary', { mode: 0o755 })
    await refreshManifest(directory)
    const transport = await temporaryDirectory('motrix-signing-transport-')
    const archiveA = path.join(transport, 'signing-a.tar')
    const archiveB = path.join(transport, 'signing-b.tar')
    const options = { platform: 'win32', arch: 'x64' }

    await createSigningArchive(directory, archiveA, options)
    await createSigningArchive(directory, archiveB, options)

    const [left, right] = await Promise.all([
      readFile(archiveA),
      readFile(archiveB),
    ])
    expect(createHash('sha256').update(left).digest('hex')).toBe(
      createHash('sha256').update(right).digest('hex')
    )
    expect(left.length).toBeLessThanOrEqual(SIGNING_ARCHIVE_LIMITS.archiveBytes)
    expect(left.length % 512).toBe(0)
    expect(left.subarray(-1024).equals(Buffer.alloc(1024))).toBe(true)
    expect(left.includes(Buffer.from('0000755\0'))).toBe(true)
  })

  it('rejects a file above the per-file tar limit before reading it', async () => {
    const directory = await createFixture()
    const oversized = path.join(directory, 'dist/electron-app/oversized.bin')
    await mkdir(path.dirname(oversized), { recursive: true })
    await writeFile(oversized, '')
    await truncate(oversized, SIGNING_ARCHIVE_LIMITS.fileBytes + 1)
    const transport = await temporaryDirectory('motrix-signing-transport-')

    await expect(
      createSigningArchive(directory, path.join(transport, 'oversized.tar'), {
        platform: 'win32',
        arch: 'x64',
      })
    ).rejects.toThrow(/file exceeds limit/)
  })
})

async function verify(directory: string) {
  return verifySigningInput({
    mode: 'verify',
    directory,
    platform: 'win32',
    arch: 'x64',
    commit: COMMIT,
  })
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createFixture(
  options: {
    files?: Array<[string, string]>
    mutateConfig?: (config: Record<string, unknown>) => void
    mutateLock?: (lock: Record<string, unknown>) => void
  } = {}
): Promise<string> {
  const directory = await temporaryDirectory('motrix-signing-input-')

  for (const [source, destination] of TRUSTED_FIXTURES) {
    const target = path.join(directory, destination)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(path.join(ROOT, source), target)
  }

  if (options.mutateConfig) {
    const configPath = path.join(directory, 'electron-builder.signing.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    options.mutateConfig(config)
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  if (options.mutateLock) {
    const lockPath = path.join(directory, 'signing-tool/package-lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<
      string,
      unknown
    >
    options.mutateLock(lock)
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  }
  for (const [relativePath, content] of options.files ?? []) {
    await writeFixtureFile(directory, relativePath, content)
  }

  await refreshManifest(directory)
  return directory
}

async function refreshManifest(directory: string) {
  const manifestPath = path.join(directory, 'signing-input-manifest.json')
  await rm(manifestPath, { force: true })
  const manifest = {
    schemaVersion: 2,
    commit: COMMIT,
    target: { key: 'win32-x64', platform: 'win32', arch: 'x64' },
    tools: { electronBuilder: '26.15.7', electron: '43.4.0' },
    limits: SIGNING_ARCHIVE_LIMITS,
    files: await inventory(directory),
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
) {
  const destination = path.join(root, relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, content)
}

async function inventory(root: string) {
  const files: Array<{
    path: string
    bytes: number
    mode: number
    sha256: string
  }> = []
  async function walk(directory: string, relative = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const portable = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, portable)
      } else {
        const [bytes, info] = await Promise.all([
          readFile(absolute),
          lstat(absolute),
        ])
        files.push({
          path: portable,
          bytes: bytes.length,
          mode: (info.mode & 0o111) === 0 ? 0o644 : 0o755,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await walk(root)
  return files
}
