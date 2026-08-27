import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageServerApp } from '../../scripts/stage-server-app.mjs'
import { verifyServerPackage } from '../../scripts/verify-server-package.mjs'

const temporaryRoots: string[] = []

interface FixtureEngineLock {
  engine: string
  version: string
  assets: Record<string, { bin: string; binarySha256: string }>
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string | Buffer = relativePath
): Promise<void> {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

function nativeHeader(platform: string, arch: string): Buffer {
  if (platform === 'win32') {
    const header = Buffer.alloc(72)
    header.write('MZ')
    header.writeUInt32LE(64, 0x3c)
    header.set([0x50, 0x45, 0, 0], 64)
    header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
    return header
  }
  if (platform === 'linux') {
    const header = Buffer.alloc(20)
    header.set([0x7f, 0x45, 0x4c, 0x46])
    header[4] = 2
    header[5] = 1
    header.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
    return header
  }
  const header = Buffer.alloc(8)
  header.set([0xcf, 0xfa, 0xed, 0xfe])
  header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  return header
}

function fixtureContract() {
  return {
    schemaVersion: 1,
    supportedTargets: [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64-gnu',
      'linux-arm64-musl',
      'linux-x64-gnu',
      'linux-x64-musl',
      'win32-x64',
    ],
    runtimeRoots: ['better-sqlite3'],
    buildInputs: [
      {
        source: 'dist/core/plugin/host/quick-js-worker.cjs',
        destination: 'dist/core/plugin/host/quick-js-worker.cjs',
        type: 'file',
        entry: null,
        scanExternals: true,
      },
      {
        source: 'dist/renderer-web',
        destination: 'dist/renderer-web',
        type: 'directory',
        entry: 'index.html',
        scanExternals: false,
      },
      {
        source: 'dist/server',
        destination: 'dist/server',
        type: 'directory',
        entry: ['index.mjs', 'motrix-admin.mjs'],
        scanExternals: true,
      },
    ],
    resourceInputs: [
      {
        source: 'LICENSE',
        destination: 'LICENSE',
        type: 'file',
      },
      {
        source: 'legal/notice.txt',
        destination: 'legal/notice.txt',
        type: 'file',
      },
    ],
  }
}

function fixtureBudgets(overrides: Record<string, number> = {}) {
  return {
    schemaVersion: 1,
    artifactBytes: 1_000_000,
    dependencyBytes: 1_000_000,
    packageInstances: 10,
    unexpectedRuntimeRoots: 0,
    unresolvedExternals: 0,
    foreignNativeBinaries: 0,
    betterSqlite3Prebuilds: 1,
    ...overrides,
  }
}

async function createStagedFixture(
  options: { withEngine?: boolean } = {}
): Promise<{
  root: string
  stageRoot: string
  reportPath: string
  contract: ReturnType<typeof fixtureContract>
  engineLock?: FixtureEngineLock
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-server-verify-'))
  temporaryRoots.push(root)
  await writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'motrix-server-fixture',
        version: '1.0.0',
        license: 'MIT',
        dependencies: { 'better-sqlite3': '13.0.3' },
      },
      null,
      2
    )}\n`
  )
  await writeFixtureFile(root, 'LICENSE', 'MIT License\n')
  await writeFixtureFile(
    root,
    'dist/server/index.mjs',
    'import Database from "better-sqlite3"; export default Database\n'
  )
  await writeFixtureFile(
    root,
    'dist/server/motrix-admin.mjs',
    'import path from "node:path"; export default path.sep;\n'
  )
  await writeFixtureFile(
    root,
    'dist/core/plugin/host/quick-js-worker.cjs',
    'module.exports = require("node:path")\n'
  )
  await writeFixtureFile(
    root,
    'dist/renderer-web/index.html',
    '<main>ok</main>'
  )
  await writeFixtureFile(root, 'legal/notice.txt', 'legal')
  await writeFixtureFile(
    root,
    'node_modules/better-sqlite3/package.json',
    `${JSON.stringify(
      {
        name: 'better-sqlite3',
        version: '13.0.3',
        main: 'lib/index.js',
      },
      null,
      2
    )}\n`
  )
  await writeFixtureFile(
    root,
    'node_modules/better-sqlite3/lib/index.js',
    'module.exports = true\n'
  )
  await writeFixtureFile(root, 'node_modules/better-sqlite3/LICENSE', 'MIT')
  for (const [name, platform, arch] of [
    ['darwin-arm64.node', 'darwin', 'arm64'],
    ['darwin-x64.node', 'darwin', 'x64'],
    ['linux-arm64.node', 'linux', 'arm64'],
    ['linux-x64.node', 'linux', 'x64'],
    ['linuxmusl-arm64.node', 'linux', 'arm64'],
    ['linuxmusl-x64.node', 'linux', 'x64'],
    ['win32-x64.node', 'win32', 'x64'],
  ]) {
    await writeFixtureFile(
      root,
      `node_modules/better-sqlite3/prebuilds/${name}`,
      nativeHeader(platform, arch)
    )
  }
  const contract = fixtureContract()
  let engineLock: FixtureEngineLock | undefined
  if (options.withEngine) {
    const engineBytes = nativeHeader('darwin', 'arm64')
    await writeFixtureFile(root, 'extra/darwin/arm64/aria2c', engineBytes)
    await chmod(path.join(root, 'extra/darwin/arm64/aria2c'), 0o755)
    contract.resourceInputs.splice(1, 0, {
      source: 'extra/{platform}/{arch}/{aria2Binary}',
      destination: 'bin/{aria2Binary}',
      type: 'file',
    })
    engineLock = {
      engine: 'aria2',
      version: '1.37.0-motrix.test',
      assets: {
        'darwin-arm64': {
          bin: 'aria2c',
          binarySha256: createHash('sha256').update(engineBytes).digest('hex'),
        },
      },
    }
  }
  await stageServerApp({
    repoRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    strict: true,
    contract,
    budgets: fixtureBudgets(),
  })
  return {
    root,
    stageRoot: path.join(root, 'dist/server-app'),
    reportPath: path.join(root, 'reports/server-darwin-arm64.json'),
    contract,
    engineLock,
  }
}

async function verifyFixture(
  fixture: Awaited<ReturnType<typeof createStagedFixture>>,
  budgets = fixtureBudgets()
) {
  return verifyServerPackage({
    appDir: fixture.stageRoot,
    platform: 'darwin',
    arch: 'arm64',
    contract: fixture.contract,
    budgets,
    reportPath: fixture.reportPath,
    engineLock: fixture.engineLock,
  })
}

describe('verifyServerPackage', () => {
  it('accepts an intact staged Server artifact and emits a sanitized report', async () => {
    const fixture = await createStagedFixture()
    const report = await verifyFixture(fixture)

    expect(report.passed).toBe(true)
    expect(report.metrics.packageInstances).toBe(1)
    expect(report.metrics.betterSqlite3Prebuilds).toBe(1)
    expect(report.metrics.foreignNativeBinaries).toBe(0)
    const reportJson = await readFile(fixture.reportPath, 'utf8')
    expect(reportJson).not.toContain(fixture.root)
    expect(JSON.parse(reportJson)).toEqual(report)
  })

  it('accepts only the target aria2 binary pinned by the engine lock', async () => {
    const fixture = await createStagedFixture({ withEngine: true })
    const report = await verifyFixture(fixture)

    expect(report.engineBinary).toEqual(
      expect.objectContaining({
        path: 'bin/aria2c',
        version: '1.37.0-motrix.test',
        format: 'mach-o',
        arch: 'arm64',
      })
    )

    const asset = fixture.engineLock?.assets['darwin-arm64']
    if (!asset) throw new Error('fixture engine lock is missing its asset')
    asset.binarySha256 = '0'.repeat(64)
    await expect(verifyFixture(fixture)).rejects.toThrow('bundled-engine')
  })

  it('fails closed on content drift and still writes the JSON report', async () => {
    const fixture = await createStagedFixture()
    await writeFixtureFile(
      fixture.stageRoot,
      'dist/server/index.mjs',
      'export default "tampered"\n'
    )

    await expect(verifyFixture(fixture)).rejects.toThrow('input-fingerprints')
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    expect(report.passed).toBe(false)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'input-fingerprints', passed: false })
    )
  })

  it('rejects a missing operator CLI bundle', async () => {
    const fixture = await createStagedFixture()
    await rm(path.join(fixture.stageRoot, 'dist/server/motrix-admin.mjs'))

    await expect(verifyFixture(fixture)).rejects.toThrow()
  })

  it('rejects a staged Server artifact without the Motrix license', async () => {
    const fixture = await createStagedFixture()
    await rm(path.join(fixture.stageRoot, 'LICENSE'))

    await expect(verifyFixture(fixture)).rejects.toThrow('project-license')
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'project-license', passed: false })
    )
  })

  it('rejects target drift and foreign native binaries', async () => {
    const fixture = await createStagedFixture()
    const stageManifestPath = path.join(
      fixture.stageRoot,
      '.motrix-server-stage.json'
    )
    const stageManifest = JSON.parse(await readFile(stageManifestPath, 'utf8'))
    stageManifest.target.key = 'darwin-x64'
    await writeFile(stageManifestPath, `${JSON.stringify(stageManifest)}\n`)
    await writeFixtureFile(
      fixture.stageRoot,
      'node_modules/better-sqlite3/prebuilds/win32-x64.node',
      nativeHeader('win32', 'x64')
    )

    await expect(verifyFixture(fixture)).rejects.toThrow('target')
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    expect(report.metrics.foreignNativeBinaries).toBe(1)
    expect(report.metrics.betterSqlite3Prebuilds).toBe(2)
  })

  it('rejects manifest roots, package closure drift, and tight budgets', async () => {
    const fixture = await createStagedFixture()
    const appManifestPath = path.join(fixture.stageRoot, 'package.json')
    const appManifest = JSON.parse(await readFile(appManifestPath, 'utf8'))
    appManifest.dependencies.unexpected = '1.0.0'
    await writeFile(appManifestPath, `${JSON.stringify(appManifest)}\n`)
    await writeFixtureFile(
      fixture.stageRoot,
      'node_modules/unexpected/package.json',
      '{"name":"unexpected","version":"1.0.0"}\n'
    )

    await expect(
      verifyFixture(fixture, fixtureBudgets({ artifactBytes: 1 }))
    ).rejects.toThrow('application-manifest')
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    expect(report.metrics.unexpectedRuntimeRoots).toBe(1)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'package-closure', passed: false })
    )
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'size-budgets', passed: false })
    )
  })

  it('rejects symlinks in the staged artifact', async () => {
    const fixture = await createStagedFixture()
    await symlink(
      path.join(fixture.stageRoot, 'legal/notice.txt'),
      path.join(fixture.stageRoot, 'legal/notice-link.txt')
    )

    await expect(verifyFixture(fixture)).rejects.toThrow('symlinks')
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'))
    expect(report.passed).toBe(false)
  })
})
