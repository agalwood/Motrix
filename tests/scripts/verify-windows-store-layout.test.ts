// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { devNull } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareWindowsStoreLayout } from '../../scripts/prepare-windows-store-layout.mjs'
import { verifyWindowsStoreLayout } from '../../scripts/verify-windows-store-layout.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import {
  createWindowsStorePayloadFixture,
  WINDOWS_STORE_PAYLOAD_METADATA,
  windowsPeHeader,
} from '../helpers/windows-store-payload-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})
const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
async function fixture() {
  const payload = await createWindowsStorePayloadFixture()
  roots.push(payload.root)
  const repoRoot = path.join(payload.root, 'checkout')
  await mkdir(repoRoot)
  git(repoRoot, 'init', '--template=', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Layout verifier fixture')
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(repoRoot, 'package.json'), '{"version":"1.2.3"}\n')
  await cp(path.resolve('build/appx'), path.join(repoRoot, 'build/appx'), {
    recursive: true,
  })
  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-m', 'fixture')
  const preparedDirectory = path.join(payload.root, 'prepared')
  const metadata = {
    ...WINDOWS_STORE_PAYLOAD_METADATA,
    profile: 'test',
    identity: WINDOWS_STORE_TEST_IDENTITY,
    source: { commit: git(repoRoot, 'rev-parse', 'HEAD') },
  }
  await prepareWindowsStoreLayout({
    repoRoot,
    appDir: payload.appDir,
    metadata,
    outputDirectory: preparedDirectory,
  })
  return {
    root: payload.root,
    repoRoot,
    preparedDirectory,
    baseline: path.join(preparedDirectory, 'layout'),
    metadata,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function indexed(input: Fixture) {
  // Synthetic bytes exercise identity checks only. No MakePri execution occurs.
  await writeFile(
    path.join(input.baseline, 'resources.pri'),
    'synthetic PRI bytes'
  )
}
async function unpacked(input: Fixture, catalog = false) {
  await indexed(input)
  const directory = path.join(input.root, 'unpacked')
  await cp(input.baseline, directory, { recursive: true })
  await writeFile(
    path.join(directory, 'AppxBlockMap.xml'),
    '<synthetic-block-map />'
  )
  await writeFile(
    path.join(directory, '[Content_Types].xml'),
    '<synthetic-content-types />'
  )
  if (catalog) {
    await mkdir(path.join(directory, 'AppxMetadata'))
    await writeFile(
      path.join(directory, 'AppxMetadata/CodeIntegrity.cat'),
      'synthetic catalog'
    )
  }
  return directory
}
async function editJson(file: string, operation: (value: any) => void) {
  const value = JSON.parse(await readFile(file, 'utf8'))
  operation(value)
  await writeFile(file, JSON.stringify(value))
}
function failed(
  report: { ok: boolean; checks: { name: string; ok: boolean }[] },
  name: string
) {
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(
    expect.objectContaining({ name, ok: false })
  )
}
afterEach(async () => {
  vi.mocked(readdir).mockReset()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store layout content verification', () => {
  it.each(['prepared', 'indexed', 'unpacked'] as const)(
    'accepts actual %s contents without claiming SDK or runtime validation',
    async (phase) => {
      const input = await fixture()
      const before = await readFile(
        path.join(input.preparedDirectory, 'layout-report.json')
      )
      let layoutDirectory: string | undefined
      if (phase === 'indexed') await indexed(input)
      if (phase === 'unpacked') layoutDirectory = await unpacked(input, true)
      const report = await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase,
        ...(layoutDirectory ? { layoutDirectory } : {}),
      })
      expect(report).toMatchObject({
        ok: true,
        phase,
        scope: 'windows-test-layout-content-only',
        versions: { productVersion: '1.2.3', packageVersion: '4.5.6.0' },
        payloadSourceVerified: false,
        sourceCommitVerified: false,
        windowsSdkExecutionVerified: false,
        generatedFileFormatsVerified: false,
        signatureVerified: false,
        windowsRuntimeVerified: false,
        storeSubmissionReady: false,
      })
      expect(
        await readFile(path.join(input.preparedDirectory, 'layout-report.json'))
      ).toEqual(before)
      expect(await readdir(input.preparedDirectory)).toEqual([
        'TEST-ONLY.txt',
        'layout',
        'layout-report.json',
        'payload-report.json',
        'pri-root',
        'priconfig.xml',
        'release-metadata.json',
        'source-report.json',
      ])
      expect(JSON.stringify(report)).not.toContain(input.root)
    }
  )

  it('uses historical source reports only as records, without requiring a source checkout', async () => {
    const input = await fixture()
    await rm(input.repoRoot, { recursive: true, force: true })
    expect(
      (
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          phase: 'prepared',
        })
      ).ok
    ).toBe(true)
  })

  it.each(['prepared', 'indexed'])(
    'rejects a different target for phase %s',
    async (phase) => {
      const input = await fixture()
      const layoutDirectory = await unpacked(input)
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          layoutDirectory,
          phase,
        }),
        'safe-inputs'
      )
    }
  )

  it.each(['absent', 'baseline'])(
    'requires a distinct explicit unpacked directory: %s',
    async (mode) => {
      const input = await fixture()
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          phase: 'unpacked',
          ...(mode === 'baseline' ? { layoutDirectory: input.baseline } : {}),
        }),
        'safe-inputs'
      )
    }
  )

  it('rejects PRI output in prepared phase', async () => {
    const input = await fixture()
    await indexed(input)
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'prepared-tree'
    )
  })

  it.each(['missing', 'empty'])(
    'requires a nonempty PRI in indexed phase: %s',
    async (mode) => {
      const input = await fixture()
      if (mode === 'empty')
        await writeFile(path.join(input.baseline, 'resources.pri'), '')
      const report = await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'indexed',
      })
      failed(report, mode === 'missing' ? 'prepared-tree' : 'indexed-pri')
    }
  )

  it.each([
    'profile',
    'identity',
    'packageVersion',
    'sourceCommit',
    'manifestSha256',
    'priConfigSha256',
    'assets',
    'payload',
    'storeSubmissionReady',
  ])('does not trust a mismatched completion field: %s', async (field) => {
    const input = await fixture()
    await editJson(
      path.join(input.preparedDirectory, 'layout-report.json'),
      (record) => {
        record[field] = field === 'storeSubmissionReady' ? true : 'tampered'
      }
    )
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'completion-record'
    )
  })

  it('rejects Store metadata even if a completion marker is present', async () => {
    const input = await fixture()
    await writeFile(
      path.join(input.preparedDirectory, 'release-metadata.json'),
      JSON.stringify(WINDOWS_STORE_PAYLOAD_METADATA)
    )
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'metadata-and-static-content'
    )
  })

  it.each(['layout/AppxManifest.xml', 'priconfig.xml'])(
    'compares %s against the renderer instead of trusting a replaced hash',
    async (file) => {
      const input = await fixture()
      await writeFile(path.join(input.preparedDirectory, file), '<altered />')
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          phase: 'prepared',
        }),
        'metadata-and-static-content'
      )
    }
  )

  it('rejects a PRI asset changed independently of the package asset', async () => {
    const input = await fixture()
    await writeFile(
      path.join(
        input.preparedDirectory,
        'pri-root/Assets/StoreLogo.scale-200.png'
      ),
      'changed'
    )
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'metadata-and-static-content'
    )
  })

  it('rechecks native payload bytes despite a forged historical success report', async () => {
    const input = await fixture()
    await writeFile(
      path.join(input.preparedDirectory, 'payload-report.json'),
      '{"ok":true}'
    )
    await writeFile(
      path.join(input.baseline, 'app/Motrix.exe'),
      windowsPeHeader(0x14c)
    )
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'prepared-payload'
    )
  })

  it.each([
    'extra-directory',
    'layout/Assets/extra-directory',
    'layout/app/empty-directory',
    'pri-root/Assets/extra-directory',
  ])('rejects extra directory %s', async (relative) => {
    const input = await fixture()
    await mkdir(path.join(input.preparedDirectory, relative))
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'prepared-tree'
    )
  })

  it.each([
    'layout/Assets/extra.png',
    'pri-root/Assets/extra.png',
    'extra.json',
  ])('rejects extra file %s', async (relative) => {
    const input = await fixture()
    await writeFile(path.join(input.preparedDirectory, relative), 'extra')
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      }),
      'prepared-tree'
    )
  })

  it.each(['layout-report.json', 'TEST-ONLY.txt', 'source-report.json'])(
    'rejects missing preparation file %s',
    async (relative) => {
      const input = await fixture()
      await unlink(path.join(input.preparedDirectory, relative))
      const report = await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        phase: 'prepared',
      })
      failed(
        report,
        relative === 'layout-report.json'
          ? 'metadata-and-static-content'
          : 'prepared-tree'
      )
    }
  )

  it.each(['resources.pri', 'AppxBlockMap.xml', '[Content_Types].xml'])(
    'rejects missing unpacked generated file %s',
    async (relative) => {
      const input = await fixture()
      const layoutDirectory = await unpacked(input)
      await unlink(path.join(layoutDirectory, relative))
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          layoutDirectory,
          phase: 'unpacked',
        }),
        'unpacked-tree'
      )
    }
  )

  it('requires unpacked PRI bytes to match the actual prepared PRI', async () => {
    const input = await fixture()
    const layoutDirectory = await unpacked(input)
    await writeFile(
      path.join(layoutDirectory, 'resources.pri'),
      'different PRI'
    )
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        layoutDirectory,
        phase: 'unpacked',
      }),
      'unpacked-tree'
    )
  })

  it.each(['AppxSignature.p7x', 'extra.txt', 'AppxMetadata/extra.cat'])(
    'rejects extra unpacked file %s',
    async (relative) => {
      const input = await fixture()
      const layoutDirectory = await unpacked(input, true)
      await writeFile(path.join(layoutDirectory, relative), 'unexpected')
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          layoutDirectory,
          phase: 'unpacked',
        }),
        'unpacked-tree'
      )
    }
  )

  it('detects a changed unpacked payload even when both PE headers are x64', async () => {
    const input = await fixture()
    const layoutDirectory = await unpacked(input)
    const bytes = windowsPeHeader()
    bytes[2] = 1
    await writeFile(path.join(layoutDirectory, 'app/Motrix.exe'), bytes)
    failed(
      await verifyWindowsStoreLayout({
        preparedDirectory: input.preparedDirectory,
        layoutDirectory,
        phase: 'unpacked',
      }),
      'unpacked-payload'
    )
  })

  it('fails closed when directory reading fails and omits raw machine diagnostics', async () => {
    const input = await fixture()
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('private-path'), { code: 'EACCES' })
    )
    const report = await verifyWindowsStoreLayout({
      preparedDirectory: input.preparedDirectory,
      phase: 'prepared',
    })
    failed(report, 'safe-inputs')
    expect(JSON.stringify(report)).not.toContain('private-path')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects dangling symlinks and non-regular files before reading content',
    async () => {
      const input = await fixture()
      const link = path.join(input.preparedDirectory, 'unexpected')
      await symlink(path.join(input.root, 'absent'), link)
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          phase: 'prepared',
        }),
        'safe-inputs'
      )
      await unlink(link)
      execFileSync('mkfifo', [link])
      failed(
        await verifyWindowsStoreLayout({
          preparedDirectory: input.preparedDirectory,
          phase: 'prepared',
        }),
        'safe-inputs'
      )
    }
  )

  it('provides strict JSON CLI results for success, missing inputs, and forbidden arguments', async () => {
    const input = await fixture()
    const script = path.resolve('scripts/verify-windows-store-layout.mjs')
    const args = [
      script,
      '--prepared',
      input.preparedDirectory,
      '--phase',
      'prepared',
    ]
    const run = (extra: string[] = []) => {
      try {
        return {
          code: 0,
          report: JSON.parse(
            execFileSync(process.execPath, [...args, ...extra], {
              env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          ),
        }
      } catch (error) {
        const failure = error as { status: number; stdout: string }
        return { code: failure.status, report: JSON.parse(failure.stdout) }
      }
    }
    expect(run()).toMatchObject({
      code: 0,
      report: { ok: true, phase: 'prepared' },
    })
    expect(run(['--skip-checks'])).toMatchObject({
      code: 1,
      report: { ok: false },
    })
    await unlink(path.join(input.preparedDirectory, 'layout-report.json'))
    expect(run()).toMatchObject({
      code: 1,
      report: { ok: false, phase: 'prepared' },
    })
  })
})
