import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeArchiveEntry,
  verifyElectronPackage,
} from '../../scripts/verify-electron-package.mjs'

type Target = {
  platform: 'darwin' | 'linux' | 'win32'
  arch: 'arm64' | 'x64'
}

type Fixture = Target & {
  root: string
  source: string
  appDir: string
  resources: string
  reportPath: string
  stage: Record<string, unknown>
}

const temporaryRoots: string[] = []
const LARGE_BUDGETS = {
  schemaVersion: 1,
  payloadBytes: 64 * 1024 * 1024,
  betterSqlite3Bytes: 4 * 1024 * 1024,
  unexpectedPackageNames: 0,
  foreignBetterSqlite3Prebuilds: 0,
  duplicateResvgWasmFiles: 0,
}
const OUTPUTS = [
  'dist/core/plugin/host/quick-js-worker.cjs',
  'dist/main/index.cjs',
  'dist/preload/preload.cjs',
  'dist/renderer/index.html',
]
const LEGAL = [
  'THIRD_PARTY_LICENSES/aria2-COPYING',
  'THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL',
  'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_NOTICES.zh-CN.md',
  'legal/THIRD_PARTY_DEPENDENCIES.md',
  'legal/THIRD_PARTY_LICENSES.txt',
  'legal/sbom.spdx.json',
]

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nativeHeader(target: Target): Buffer {
  if (target.platform === 'linux') {
    const header = Buffer.alloc(20)
    header.set([0x7f, 0x45, 0x4c, 0x46])
    header[4] = 2
    header[5] = 1
    header.writeUInt16LE(target.arch === 'arm64' ? 183 : 62, 18)
    return header
  }
  if (target.platform === 'win32') {
    const header = Buffer.alloc(72)
    header.write('MZ')
    header.writeUInt32LE(64, 0x3c)
    header.set([0x50, 0x45, 0, 0], 64)
    header.writeUInt16LE(target.arch === 'arm64' ? 0xaa64 : 0x8664, 68)
    return header
  }
  const header = Buffer.alloc(8)
  header.set([0xcf, 0xfa, 0xed, 0xfe])
  header.writeUInt32LE(target.arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  return header
}

async function write(
  root: string,
  relativePath: string,
  content: string | Buffer
) {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

async function writeJson(root: string, relativePath: string, value: unknown) {
  return write(root, relativePath, `${JSON.stringify(value)}\n`)
}

async function createFixture(
  target: Target = { platform: 'darwin', arch: 'arm64' },
  mutate?: (fixture: Fixture) => Promise<void>
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-package-verify-'))
  temporaryRoots.push(root)
  const source = path.join(root, 'source')
  const appDir = path.join(
    root,
    target.platform === 'darwin' ? 'Motrix.app' : 'motrix'
  )
  const resources = path.join(
    appDir,
    ...(target.platform === 'darwin'
      ? ['Contents', 'Resources']
      : ['resources'])
  )
  const reportPath = path.join(root, 'report.json')
  await mkdir(source, { recursive: true })
  await mkdir(resources, { recursive: true })

  const buildOutputs = []
  for (const relativePath of OUTPUTS) {
    const content = Buffer.from(relativePath)
    await write(source, relativePath, content)
    buildOutputs.push({
      path: relativePath,
      bytes: content.length,
      sha256: hash(content),
    })
  }
  await writeJson(source, 'package.json', {
    name: 'motrix-fixture',
    version: '1.2.3',
    main: 'dist/main/index.cjs',
  })
  await writeJson(source, 'node_modules/better-sqlite3/package.json', {
    name: 'better-sqlite3',
    version: '1.0.0',
    main: 'lib/index.js',
  })
  await write(source, 'node_modules/better-sqlite3/LICENSE', 'license')
  await write(
    source,
    'node_modules/better-sqlite3/lib/index.js',
    'module.exports = {}'
  )
  await write(
    source,
    `node_modules/better-sqlite3/prebuilds/${target.platform}-${target.arch}.node`,
    nativeHeader(target)
  )
  await writeJson(source, 'node_modules/fixture-dep/package.json', {
    name: 'fixture-dep',
    version: '2.0.0',
    exports: {
      '.': './index.js',
      './subpath': './subpath.js',
    },
  })
  await write(
    source,
    'node_modules/fixture-dep/index.js',
    'export default true'
  )
  await write(
    source,
    'node_modules/fixture-dep/subpath.js',
    'export default true'
  )

  const packages = [
    {
      destination: 'node_modules/better-sqlite3',
      name: 'better-sqlite3',
      version: '1.0.0',
    },
    {
      destination: 'node_modules/fixture-dep',
      name: 'fixture-dep',
      version: '2.0.0',
    },
  ]
  const resvg = Buffer.from('fixture-resvg-wasm')
  if (target.platform === 'darwin') {
    await writeJson(source, 'node_modules/@resvg/resvg-wasm/package.json', {
      name: '@resvg/resvg-wasm',
      version: '3.0.0',
      main: 'index.js',
    })
    await write(
      source,
      'node_modules/@resvg/resvg-wasm/index.js',
      'export const ok = true'
    )
    packages.push({
      destination: 'node_modules/@resvg/resvg-wasm',
      name: '@resvg/resvg-wasm',
      version: '3.0.0',
    })
    await write(resources, 'extra/tray/resvg.wasm', resvg)
  }
  packages.sort((left, right) =>
    left.destination.localeCompare(right.destination)
  )
  const stage = {
    schemaVersion: 1,
    target: { ...target, key: `${target.platform}-${target.arch}` },
    rootVersion: '1.2.3',
    buildOutputs,
    externals: ['better-sqlite3', 'fixture-dep/subpath'],
    inventory: { files: 10, bytes: 100 },
    optionalOmissions: [],
    packages,
    ...(target.platform === 'darwin' ? { resvgWasmSha256: hash(resvg) } : {}),
  }
  await writeJson(source, '.motrix-package-stage.json', stage)

  const executable = nativeHeader(target)
  const hostName =
    target.platform === 'win32'
      ? 'motrix-native-host.exe'
      : 'motrix-native-host'
  const engineName = target.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const host = await write(resources, `bin/${hostName}`, executable)
  const engine = await write(
    resources,
    `extra/${target.platform}/${target.arch}/${engineName}`,
    executable
  )
  await chmod(host, 0o755)
  await chmod(engine, 0o755)
  for (const relativePath of LEGAL)
    await write(resources, relativePath, relativePath)
  await writeJson(
    resources,
    'builtin-plugins/motrix.fixture/motrix-plugin.json',
    { id: 'motrix.fixture' }
  )
  await write(
    resources,
    'builtin-plugins/motrix.fixture/dist/plugin.js',
    'export default true'
  )
  if (target.platform === 'darwin') {
    await write(
      appDir,
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak',
      'locale'
    )
  } else {
    await write(appDir, 'locales/en-US.pak', 'locale')
  }

  const fixture: Fixture = {
    ...target,
    root,
    source,
    appDir,
    resources,
    reportPath,
    stage,
  }
  await mutate?.(fixture)
  await createPackageWithOptions(source, path.join(resources, 'app.asar'), {
    dot: true,
    unpackDir: 'dist/renderer',
  })
  return fixture
}

async function verify(
  fixture: Fixture,
  budgets = LARGE_BUDGETS,
  reportPath = fixture.reportPath
) {
  return verifyElectronPackage({
    appDir: fixture.appDir,
    platform: fixture.platform,
    arch: fixture.arch,
    budgets,
    reportPath,
  })
}

function failedCheck(report: Awaited<ReturnType<typeof verify>>, id: string) {
  return report.checks.find((entry: { id: string }) => entry.id === id)
}

describe('post-package Electron verification', () => {
  it('normalizes Windows ASAR listings to portable archive paths', () => {
    expect(
      normalizeArchiveEntry(
        '\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node'
      )
    ).toBe('node_modules/better-sqlite3/prebuilds/win32-x64.node')
  })

  it('accepts a target-matched ASAR, stage, dependencies, and resources', async () => {
    const fixture = await createFixture()
    const report = await verify(fixture)

    expect(report.passed).toBe(true)
    expect(report.target.key).toBe('darwin-arm64')
    expect(report.packages.records).toEqual(report.inputStage?.packages)
    expect(report.metrics).toMatchObject({
      unexpectedPackageNames: 0,
      foreignBetterSqlite3Prebuilds: 0,
      duplicateResvgWasmFiles: 0,
    })
    expect(report.externalResources.updateMetadata).toEqual([
      {
        path: 'app-update.yml',
        present: false,
        policy: 'directory-output',
      },
    ])
    const asarInfo = await stat(path.join(fixture.resources, 'app.asar'))
    const rendererInfo = await stat(
      path.join(fixture.resources, 'app.asar.unpacked/dist/renderer/index.html')
    )
    expect(report.sizes.payloadBytes).toBe(asarInfo.size + rendererInfo.size)
  })

  it.each([
    ['stage manifest', '.motrix-package-stage.json', 'stage-manifest'],
    ['packaged manifest', 'package.json', 'stage-manifest'],
    ['main', 'dist/main/index.cjs', 'required-build-outputs'],
    ['preload', 'dist/preload/preload.cjs', 'required-build-outputs'],
    [
      'worker',
      'dist/core/plugin/host/quick-js-worker.cjs',
      'required-build-outputs',
    ],
    ['renderer', 'dist/renderer/index.html', 'required-build-outputs'],
  ])('rejects a package missing %s', async (_label, relativePath, checkId) => {
    const fixture = await createFixture(undefined, async ({ source }) => {
      await unlink(path.join(source, relativePath))
    })
    const report = await verify(fixture)
    expect(report.passed).toBe(false)
    expect(failedCheck(report, checkId)?.passed).toBe(false)
  })

  it('writes a failure report when app.asar is missing', async () => {
    const fixture = await createFixture()
    await unlink(path.join(fixture.resources, 'app.asar'))
    const report = await verify(fixture)

    expect(report.passed).toBe(false)
    expect(failedCheck(report, 'asar-inventory')?.passed).toBe(false)
    expect(JSON.parse(await readFile(fixture.reportPath, 'utf8')).passed).toBe(
      false
    )
  })

  it.each([
    'dist/server/index.js',
    'dist/renderer-web/index.html',
    'dist/builtin-plugins/mirror.js',
  ])('rejects forbidden output %s', async (relativePath) => {
    const fixture = await createFixture(undefined, async ({ source }) => {
      await write(source, relativePath, 'forbidden')
    })
    const report = await verify(fixture)
    expect(failedCheck(report, 'forbidden-dist-outputs')?.passed).toBe(false)
  })

  it('rejects unexpected, nested, mismatched, and unresolved packages', async () => {
    const unexpected = await createFixture(undefined, async ({ source }) => {
      await writeJson(source, 'node_modules/unexpected/package.json', {
        name: 'unexpected',
        version: '1.0.0',
      })
    })
    const unexpectedReport = await verify(unexpected)
    expect(failedCheck(unexpectedReport, 'package-inventory')?.passed).toBe(
      false
    )
    expect(unexpectedReport.packages.unexpectedNames).toEqual(['unexpected'])

    const nested = await createFixture(undefined, async ({ source }) => {
      await writeJson(
        source,
        'node_modules/fixture-dep/node_modules/nested/package.json',
        { name: 'nested', version: '1.0.0' }
      )
    })
    expect(failedCheck(await verify(nested), 'package-inventory')?.passed).toBe(
      false
    )

    const version = await createFixture(undefined, async ({ source }) => {
      await writeJson(source, 'node_modules/fixture-dep/package.json', {
        name: 'fixture-dep',
        version: '9.0.0',
        exports: { '.': './index.js', './subpath': './subpath.js' },
      })
    })
    expect(
      failedCheck(await verify(version), 'package-inventory')?.passed
    ).toBe(false)

    const unresolved = await createFixture(undefined, async (fixture) => {
      ;(fixture.stage.externals as string[]) = ['fixture-dep/missing']
      await writeJson(
        fixture.source,
        '.motrix-package-stage.json',
        fixture.stage
      )
    })
    expect(
      failedCheck(await verify(unresolved), 'static-externals')?.passed
    ).toBe(false)
  })

  it.each([
    [
      'zero prebuilds',
      async (fixture: Fixture) =>
        unlink(
          path.join(
            fixture.source,
            'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'
          )
        ),
    ],
    [
      'multiple prebuilds',
      async (fixture: Fixture) =>
        write(
          fixture.source,
          'node_modules/better-sqlite3/prebuilds/darwin-x64.node',
          nativeHeader({ platform: 'darwin', arch: 'x64' })
        ),
    ],
    [
      'malformed prebuild',
      async (fixture: Fixture) =>
        write(
          fixture.source,
          'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
          'not-native'
        ),
    ],
    [
      'source leakage',
      async (fixture: Fixture) =>
        write(
          fixture.source,
          'node_modules/better-sqlite3/src/leak.cc',
          'source'
        ),
    ],
  ])('rejects better-sqlite3 with %s', async (_label, mutate) => {
    const fixture = await createFixture(undefined, mutate)
    const report = await verify(fixture)
    expect(failedCheck(report, 'better-sqlite3-layout')?.passed).toBe(false)
  })

  it('enforces resvg placement and hash only on macOS', async () => {
    const duplicate = await createFixture(undefined, async ({ source }) => {
      await write(
        source,
        'node_modules/@resvg/resvg-wasm/index_bg.wasm',
        'duplicate'
      )
    })
    expect(
      failedCheck(await verify(duplicate), 'resvg-wasm-placement')?.passed
    ).toBe(false)

    const missing = await createFixture(undefined, async ({ resources }) => {
      await unlink(path.join(resources, 'extra/tray/resvg.wasm'))
    })
    expect(
      failedCheck(await verify(missing), 'resvg-wasm-placement')?.passed
    ).toBe(false)

    const mismatch = await createFixture(undefined, async ({ resources }) => {
      await write(resources, 'extra/tray/resvg.wasm', 'wrong-hash')
    })
    expect(
      failedCheck(await verify(mismatch), 'resvg-wasm-placement')?.passed
    ).toBe(false)

    const linux = await createFixture({ platform: 'linux', arch: 'arm64' })
    expect((await verify(linux)).passed).toBe(true)
  })

  it('accepts Windows PE binaries and resources', async () => {
    const windows = await createFixture({ platform: 'win32', arch: 'x64' })
    expect((await verify(windows)).passed).toBe(true)
  })

  it.each([
    'extra/darwin/arm64/aria2c',
    'bin/motrix-native-host',
    'builtin-plugins/motrix.fixture/motrix-plugin.json',
    'THIRD_PARTY_NOTICES.md',
  ])('rejects a missing external resource %s', async (relativePath) => {
    const fixture = await createFixture(undefined, async ({ resources }) => {
      await unlink(path.join(resources, relativePath))
    })
    const report = await verify(fixture)
    const checkId = relativePath.startsWith('builtin-plugins')
      ? 'builtin-plugins'
      : 'external-resources'
    expect(failedCheck(report, checkId)?.passed).toBe(false)
  })

  it('validates optional directory update metadata when present', async () => {
    const fixture = await createFixture(undefined, async ({ resources }) => {
      await write(resources, 'app-update.yml', '')
    })
    expect(
      failedCheck(await verify(fixture), 'update-metadata-policy')?.passed
    ).toBe(false)
  })

  it('enforces the payload budget at the exact byte boundary', async () => {
    const fixture = await createFixture()
    const initial = await verify(fixture)
    const exact = {
      ...LARGE_BUDGETS,
      payloadBytes: initial.sizes.payloadBytes,
    }
    expect((await verify(fixture, exact)).passed).toBe(true)

    const over = await verify(fixture, {
      ...exact,
      payloadBytes: exact.payloadBytes - 1,
    })
    expect(failedCheck(over, 'budget-payloadBytes')?.passed).toBe(false)
  })

  it('keeps locale variation outside optimizer pass/fail metrics', async () => {
    const small = await createFixture()
    const large = await createFixture(undefined, async ({ appDir }) => {
      await write(
        appDir,
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN.lproj/locale.pak',
        Buffer.alloc(4096)
      )
    })
    const smallReport = await verify(small)
    const largeReport = await verify(large)

    expect(smallReport.passed).toBe(true)
    expect(largeReport.passed).toBe(true)
    expect(largeReport.metrics).toEqual(smallReport.metrics)
    expect(largeReport.sizes.localeBytes).toBeGreaterThan(
      smallReport.sizes.localeBytes
    )
  })

  it('writes deterministic sanitized pass and fail reports', async () => {
    const fixture = await createFixture()
    const passPath = path.join(fixture.root, 'pass.json')
    const failPath = path.join(fixture.root, 'fail.json')
    const secret = 'motrix-fixture-environment-secret'
    process.env.MOTRIX_TEST_PACKAGE_SECRET = secret
    try {
      await verify(fixture, LARGE_BUDGETS, passPath)
      await verify(fixture, { ...LARGE_BUDGETS, payloadBytes: 0 }, failPath)
    } finally {
      delete process.env.MOTRIX_TEST_PACKAGE_SECRET
    }
    const pass = await readFile(passPath, 'utf8')
    const fail = await readFile(failPath, 'utf8')

    for (const content of [pass, fail]) {
      expect(content).not.toContain(fixture.root)
      expect(content).not.toContain(os.homedir())
      expect(content).not.toContain(secret)
    }
    const parsed = JSON.parse(pass)
    expect(parsed.packages.names).toEqual([...parsed.packages.names].sort())
    expect(parsed.nativeBinaries).toEqual(
      [...parsed.nativeBinaries].sort((left, right) =>
        left.path.localeCompare(right.path)
      )
    )
    expect((await stat(failPath)).isFile()).toBe(true)
  })
})
