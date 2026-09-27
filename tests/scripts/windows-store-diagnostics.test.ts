// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  cp,
  lstat,
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
import { verifyWindowsStorePayload } from '../../scripts/verify-windows-store-payload.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import {
  createWindowsStorePayloadFixture,
  payloadFixtureSha256 as hash,
  WINDOWS_STORE_PAYLOAD_METADATA,
} from '../helpers/windows-store-payload-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, cp: vi.fn(actual.cp) }
})

const MODE = 'native-messaging-probe-v1'
const SOURCE = 'tests/fixtures/windows-store-native-messaging/stdio-probe.cs'
const EXECUTABLE = 'motrix-store-p0-probe.exe'
const LAYOUT_EXECUTABLE = `diagnostics/${EXECUTABLE}`
const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function consolePe() {
  // Synthetic PE headers exercise validation only; this is not runnable code.
  const bytes = Buffer.alloc(512)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(0x8664, 68)
  bytes.writeUInt16LE(0xf0, 84)
  bytes.writeUInt16LE(0x0002, 86)
  bytes.writeUInt16LE(0x020b, 88)
  bytes.writeUInt16LE(3, 156)
  return bytes
}

async function fixture() {
  const payload = await createWindowsStorePayloadFixture()
  roots.push(payload.root)
  const repoRoot = path.join(payload.root, 'checkout')
  await mkdir(repoRoot)
  git(repoRoot, 'init', '--template=', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Diagnostics fixture')
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(repoRoot, 'package.json'), '{"version":"1.2.3"}\n')
  await cp(path.resolve('build/appx'), path.join(repoRoot, 'build/appx'), {
    recursive: true,
  })
  await mkdir(path.dirname(path.join(repoRoot, SOURCE)), { recursive: true })
  await cp(path.resolve(SOURCE), path.join(repoRoot, SOURCE))
  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-m', 'fixed diagnostic source fixture')
  const probeBuildDirectory = path.join(payload.root, 'probe-build')
  await mkdir(probeBuildDirectory)
  const executable = consolePe()
  const source = await readFile(path.join(repoRoot, SOURCE))
  // Match the PowerShell builder's schema without running any compiler or EXE.
  const buildReport = {
    schemaVersion: 1,
    scope: 'windows-native-messaging-probe-build',
    ok: true,
    compiled: true,
    compiler: 'Windows .NET Framework64 csc',
    source: { path: SOURCE, sha256: hash(source) },
    executable: {
      path: EXECUTABLE,
      bytes: executable.length,
      sha256: hash(executable),
      peMachine: '0x8664',
      peMachineVerified: true,
      peOptionalHeaderMagic: '0x020b',
      peSubsystem: '0x0003',
      consoleSubsystemVerified: true,
    },
    directStdioVerified: false,
    packagedActivationVerified: false,
    browserNativeMessagingVerified: false,
    mbp1Verified: false,
  }
  await writeFile(path.join(probeBuildDirectory, EXECUTABLE), executable)
  await writeFile(
    path.join(probeBuildDirectory, 'build-report.json'),
    JSON.stringify(buildReport)
  )
  return {
    root: payload.root,
    repoRoot,
    appDir: payload.appDir,
    probeBuildDirectory,
    outputDirectory: path.join(payload.root, 'prepared'),
    metadata: {
      ...WINDOWS_STORE_PAYLOAD_METADATA,
      profile: 'test',
      identity: WINDOWS_STORE_TEST_IDENTITY,
      source: { commit: git(repoRoot, 'rev-parse', 'HEAD') },
      testDiagnostics: MODE,
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function editJson(file: string, change: (record: any) => void) {
  const record = JSON.parse(await readFile(file, 'utf8'))
  change(record)
  await writeFile(file, JSON.stringify(record))
}
function completion(input: Fixture) {
  return path.join(input.outputDirectory, 'layout-report.json')
}
function buildReport(input: Fixture) {
  return path.join(input.probeBuildDirectory, 'build-report.json')
}
function baseline(input: Fixture) {
  return path.join(input.outputDirectory, 'layout')
}
async function verify(
  input: Fixture,
  phase = 'prepared',
  layoutDirectory?: string
) {
  return verifyWindowsStoreLayout({
    preparedDirectory: input.outputDirectory,
    phase,
    ...(layoutDirectory ? { layoutDirectory } : {}),
  })
}
async function makeUnpacked(input: Fixture) {
  // These are opaque identity fixtures, not outputs of Windows SDK tools.
  await writeFile(path.join(baseline(input), 'resources.pri'), 'synthetic PRI')
  const target = path.join(input.root, 'unpacked')
  await cp(baseline(input), target, { recursive: true })
  await writeFile(
    path.join(target, 'AppxBlockMap.xml'),
    '<synthetic-block-map />'
  )
  return target
}
function expectRejected(report: { ok: boolean; checks: { ok: boolean }[] }) {
  expect(report.ok).toBe(false)
  expect(report.checks.some((check) => !check.ok)).toBe(true)
}

afterEach(async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(cp).mockReset().mockImplementation(actual.cp)
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store diagnostic layout contract', () => {
  it.each(['prepared', 'indexed', 'unpacked'] as const)(
    'retains checked diagnostic bytes in a %s layout without runtime claims',
    async (phase) => {
      const input = await fixture()
      const report = await prepareWindowsStoreLayout(input)
      const originalReport = await readFile(buildReport(input))
      const executable = await readFile(
        path.join(input.probeBuildDirectory, EXECUTABLE)
      )
      expect(report.diagnostics).toMatchObject({
        mode: MODE,
        source: {
          commit: input.metadata.source.commit,
          path: SOURCE,
          sha256: hash(await readFile(path.join(input.repoRoot, SOURCE))),
        },
        executable: {
          path: LAYOUT_EXECUTABLE,
          bytes: executable.length,
          sha256: hash(executable),
        },
        buildReportSha256: hash(originalReport),
        packagedActivationVerified: false,
        browserNativeMessagingVerified: false,
        mbp1Verified: false,
      })
      expect(
        await readFile(path.join(baseline(input), LAYOUT_EXECUTABLE))
      ).toEqual(executable)
      expect(
        await readFile(
          path.join(input.outputDirectory, 'diagnostic-build-report.json')
        )
      ).toEqual(originalReport)
      expect(await readdir(path.join(baseline(input), 'diagnostics'))).toEqual([
        EXECUTABLE,
      ])
      const manifest = await readFile(
        path.join(baseline(input), 'AppxManifest.xml'),
        'utf8'
      )
      expect(manifest).toContain('Application Id="MotrixNativeHostP0"')
      expect(manifest).toContain('Alias="motrix-store-p0-native-host.exe"')
      expect(manifest).toContain(`Executable="diagnostics\\${EXECUTABLE}"`)
      expect(
        report.payload.some((file: { path: string }) =>
          file.path.includes(EXECUTABLE)
        )
      ).toBe(false)
      let target: string | undefined
      if (phase === 'indexed')
        await writeFile(
          path.join(baseline(input), 'resources.pri'),
          'synthetic PRI'
        )
      if (phase === 'unpacked') target = await makeUnpacked(input)
      const verified = await verify(input, phase, target)
      expect(verified).toMatchObject({
        ok: true,
        phase,
        windowsSdkExecutionVerified: false,
        windowsRuntimeVerified: false,
        storeSubmissionReady: false,
      })
      expect(JSON.stringify(report)).not.toContain(input.root)
      expect(git(input.repoRoot, 'status', '--porcelain')).toBe('')
    }
  )

  it('requires diagnostic mode and an explicit probe build directory together', async () => {
    const input = await fixture()
    const { testDiagnostics: _mode, ...normalMetadata } = input.metadata
    await expect(
      prepareWindowsStoreLayout({ ...input, metadata: normalMetadata })
    ).rejects.toThrow()
    await expect(
      prepareWindowsStoreLayout({ ...input, probeBuildDirectory: undefined })
    ).rejects.toThrow()
    await expect(lstat(input.outputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a probe replaced during payload copying even when its build report is refreshed', async () => {
    const input = await fixture()
    const original = await readFile(
      path.join(input.probeBuildDirectory, EXECUTABLE)
    )
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    let changedDuringCopy = false
    vi.mocked(cp).mockImplementationOnce(
      async (source, destination, settings) => {
        expect(source).toBe(input.appDir)
        expect(destination).toBe(path.join(baseline(input), 'app'))
        await actual.cp(source, destination, settings)
        const changed = Buffer.from(original)
        changed[changed.length - 1] ^= 1
        await writeFile(
          path.join(input.probeBuildDirectory, EXECUTABLE),
          changed
        )
        // The new pair remains internally consistent. The final preparation
        // check must compare it with the originally accepted input snapshot.
        await editJson(buildReport(input), (record) => {
          record.executable.sha256 = hash(changed)
        })
        changedDuringCopy = true
      }
    )
    await expect(prepareWindowsStoreLayout(input)).rejects.toThrow(
      'Diagnostic probe changed during layout assembly'
    )
    expect(changedDuringCopy).toBe(true)
    expect(
      await readFile(path.join(baseline(input), LAYOUT_EXECUTABLE))
    ).toEqual(original)
    for (const marker of ['layout-report.json', 'preparation-complete.json']) {
      await expect(
        lstat(path.join(input.outputDirectory, marker))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it.each(['source-hash', 'executable-hash', 'runtime-claim'])(
    'rejects an invalid probe build report: %s',
    async (change) => {
      const input = await fixture()
      await editJson(buildReport(input), (record) => {
        if (change === 'source-hash') record.source.sha256 = '0'.repeat(64)
        if (change === 'executable-hash')
          record.executable.sha256 = '0'.repeat(64)
        if (change === 'runtime-claim')
          record.browserNativeMessagingVerified = true
      })
      await expect(prepareWindowsStoreLayout(input)).rejects.toThrow()
      await expect(lstat(completion(input))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  it.each(['missing-exe', 'missing-report', 'symlink-exe', 'symlink-report'])(
    'rejects a missing or indirect build input: %s',
    async (change) => {
      const input = await fixture()
      const file = path.join(
        input.probeBuildDirectory,
        change.endsWith('exe') ? EXECUTABLE : 'build-report.json'
      )
      const original = await readFile(file)
      await unlink(file)
      if (change.startsWith('symlink')) {
        const outside = path.join(input.root, 'external-input')
        await writeFile(outside, original)
        await symlink(outside, file)
      }
      await expect(prepareWindowsStoreLayout(input)).rejects.toThrow()
    }
  )

  it.each(['pe32', 'gui', 'dll'])(
    'rejects non-console x64 executable structure even with refreshed hash: %s',
    async (change) => {
      const input = await fixture()
      const bytes = consolePe()
      if (change === 'pe32') bytes.writeUInt16LE(0x010b, 88)
      if (change === 'gui') bytes.writeUInt16LE(2, 156)
      if (change === 'dll') bytes.writeUInt16LE(0x2002, 86)
      await writeFile(path.join(input.probeBuildDirectory, EXECUTABLE), bytes)
      await editJson(buildReport(input), (record) => {
        record.executable.sha256 = hash(bytes)
      })
      await expect(prepareWindowsStoreLayout(input)).rejects.toThrow()
    }
  )

  it('keeps a normal layout free of diagnostic payloads', async () => {
    const input = await fixture()
    const { testDiagnostics: _mode, ...normalMetadata } = input.metadata
    const report = await prepareWindowsStoreLayout({
      ...input,
      metadata: normalMetadata,
      probeBuildDirectory: undefined,
    })
    expect(report.diagnostics).toBeUndefined()
    expect((await verify(input)).ok).toBe(true)
    await mkdir(path.join(baseline(input), 'diagnostics'))
    await writeFile(path.join(baseline(input), LAYOUT_EXECUTABLE), consolePe())
    expectRejected(await verify(input))
  })

  it('does not allow the probe to enter the application resources/bin payload', async () => {
    const input = await fixture()
    await writeFile(
      path.join(input.appDir, 'resources/bin', EXECUTABLE),
      consolePe()
    )
    expectRejected(
      await verifyWindowsStorePayload({
        appDir: input.appDir,
        metadata: input.metadata,
      })
    )
  })

  it.each(['source', 'executable', 'build-report'])(
    'does not trust a modified diagnostic completion digest: %s',
    async (change) => {
      const input = await fixture()
      await prepareWindowsStoreLayout(input)
      await editJson(completion(input), (record) => {
        if (change === 'source')
          record.diagnostics.source.sha256 = '0'.repeat(64)
        if (change === 'executable')
          record.diagnostics.executable.sha256 = '0'.repeat(64)
        if (change === 'build-report')
          record.diagnostics.buildReportSha256 = '0'.repeat(64)
      })
      expectRejected(await verify(input))
    }
  )

  it.each(['helper-path', 'alias'])(
    'rejects a changed diagnostic manifest contract despite refreshing its digest: %s',
    async (change) => {
      const input = await fixture()
      await prepareWindowsStoreLayout(input)
      const file = path.join(baseline(input), 'AppxManifest.xml')
      const before = await readFile(file, 'utf8')
      const after =
        change === 'helper-path'
          ? before.replaceAll(`diagnostics\\${EXECUTABLE}`, 'app\\Motrix.exe')
          : before.replace(
              /(<[^>]*ExecutionAlias\b[^>]*\bAlias=")[^"]+("[^>]*\/?>)/,
              '$1changed-probe.exe$2'
            )
      expect(after).not.toBe(before)
      await writeFile(file, after)
      await editJson(completion(input), (record) => {
        record.manifestSha256 = hash(after)
      })
      expectRejected(await verify(input))
    }
  )

  it('rejects changed unpacked probe bytes even when the prepared layout is intact', async () => {
    const input = await fixture()
    await prepareWindowsStoreLayout(input)
    const target = await makeUnpacked(input)
    const bytes = await readFile(path.join(target, LAYOUT_EXECUTABLE))
    bytes[bytes.length - 1] ^= 1
    await writeFile(path.join(target, LAYOUT_EXECUTABLE), bytes)
    expectRejected(await verify(input, 'unpacked', target))
  })

  it.each(['file', 'empty-directory'])(
    'rejects extra diagnostic tree entries: %s',
    async (change) => {
      const input = await fixture()
      await prepareWindowsStoreLayout(input)
      const extra = path.join(baseline(input), 'diagnostics', 'unexpected')
      if (change === 'file') await writeFile(extra, 'unexpected')
      else await mkdir(extra)
      expectRejected(await verify(input))
    }
  )

  it('keeps package identity and diagnostic alias stable when only the package version increases', async () => {
    const input = await fixture()
    const first = await prepareWindowsStoreLayout(input)
    const firstManifest = await readFile(
      path.join(baseline(input), 'AppxManifest.xml'),
      'utf8'
    )
    const next = {
      ...input,
      outputDirectory: path.join(input.root, 'prepared-next'),
      metadata: { ...input.metadata, packageVersion: '4.5.7.0' },
    }
    const second = await prepareWindowsStoreLayout(next)
    const secondManifest = await readFile(
      path.join(baseline(next), 'AppxManifest.xml'),
      'utf8'
    )
    expect(second.identity).toEqual(first.identity)
    expect(second.diagnostics).toEqual(first.diagnostics)
    expect(second.packageVersion).toBe('4.5.7.0')
    expect(
      secondManifest.replace('Version="4.5.7.0"', 'Version="4.5.6.0"')
    ).toBe(firstManifest)
    expect(firstManifest).toMatch(/ExecutionAlias\b[^>]*\bAlias="[^"]+"/)
    expect((await verify(next)).ok).toBe(true)
  })
})
