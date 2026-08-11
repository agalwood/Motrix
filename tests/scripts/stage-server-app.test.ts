import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageServerApp } from '../../scripts/stage-server-app.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content = relativePath
): Promise<void> {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function writePackage(
  root: string,
  relativePath: string,
  manifest: {
    name: string
    version: string
    type?: string
    exports?: unknown
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    os?: string[]
    cpu?: string[]
  }
): Promise<void> {
  await writeFixtureFile(
    root,
    `${relativePath}/package.json`,
    `${JSON.stringify({ main: 'index.js', ...manifest }, null, 2)}\n`
  )
  await writeFixtureFile(
    root,
    `${relativePath}/index.js`,
    manifest.type === 'module'
      ? 'export default true\n'
      : 'module.exports = true\n'
  )
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
    runtimeRoots: ['@scope/pkg', 'alpha', 'gamma'],
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
        entry: 'index.mjs',
        scanExternals: true,
      },
    ],
    resourceInputs: [
      {
        source: 'legal/notice.txt',
        destination: 'legal/notice.txt',
        type: 'file',
      },
    ],
  }
}

function fixtureBudgets() {
  return {
    schemaVersion: 1,
    artifactBytes: 100_000_000,
    dependencyBytes: 80_000_000,
    packageInstances: 100,
    unexpectedRuntimeRoots: 0,
    unresolvedExternals: 0,
    foreignNativeBinaries: 0,
    betterSqlite3Prebuilds: 1,
  }
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-server-stage-'))
  temporaryRoots.push(root)
  await writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'motrix-source-fixture',
        productName: 'Motrix Fixture',
        version: '1.2.3',
        description: 'fixture',
        homepage: 'https://example.test',
        author: { name: 'Motrix' },
        license: 'MIT',
        private: true,
        scripts: { forbidden: 'true' },
        devDependencies: { forbidden: '1.0.0' },
        dependencies: {
          '@scope/pkg': '1.0.0',
          alpha: '1.0.0',
          gamma: '1.0.0',
          unrelated: '1.0.0',
        },
      },
      null,
      2
    )}\n`
  )
  await writeFixtureFile(
    root,
    'dist/server/index.mjs',
    [
      'import alpha from "alpha/subpath";',
      'import gamma from "gamma";',
      'export { alpha, gamma };',
    ].join('\n')
  )
  await writeFixtureFile(
    root,
    'dist/core/plugin/host/quick-js-worker.cjs',
    'module.exports = require("@scope/pkg")\n'
  )
  await writeFixtureFile(
    root,
    'dist/renderer-web/index.html',
    '<main>ok</main>'
  )
  await writeFixtureFile(root, 'legal/notice.txt', 'legal')
  await writeFixtureFile(root, 'dist/main/forbidden.cjs', 'forbidden')

  await writePackage(root, 'node_modules/alpha', {
    name: 'alpha',
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': { import: './index.js' },
      './subpath': { import: './subpath.js' },
    },
    dependencies: { beta: '1.0.0', shared: '1.0.0' },
    optionalDependencies: {
      'linux-only': '1.0.0',
      'missing-native': '1.0.0',
    },
  })
  await writeFixtureFile(
    root,
    'node_modules/alpha/subpath.js',
    'export default true\n'
  )
  await writePackage(root, 'node_modules/beta', {
    name: 'beta',
    version: '1.0.0',
    dependencies: { alpha: '1.0.0' },
  })
  await writePackage(root, 'node_modules/shared', {
    name: 'shared',
    version: '1.0.0',
  })
  await writePackage(root, 'node_modules/gamma', {
    name: 'gamma',
    version: '1.0.0',
    dependencies: { shared: '2.0.0' },
  })
  await writePackage(root, 'node_modules/gamma/node_modules/shared', {
    name: 'shared',
    version: '2.0.0',
  })
  await writePackage(root, 'node_modules/@scope/pkg', {
    name: '@scope/pkg',
    version: '1.0.0',
  })
  await writePackage(root, 'node_modules/linux-only', {
    name: 'linux-only',
    version: '1.0.0',
    os: ['linux'],
  })
  return root
}

async function listSymlinks(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      const info = await lstat(entryPath)
      if (info.isSymbolicLink()) result.push(entryPath)
      else if (info.isDirectory()) await walk(entryPath)
    }
  }
  await walk(root)
  return result
}

describe('stageServerApp', () => {
  it('creates an atomic minimal Server app with the exact dependency closure', async () => {
    const root = await createFixture()
    const sourceTimestamp = (await stat(path.join(root, 'node_modules/alpha')))
      .mtimeMs
    const result = await stageServerApp({
      repoRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
      budgets: fixtureBudgets(),
    })
    const stageRoot = path.join(root, 'dist/server-app')
    const stage = JSON.parse(
      await readFile(path.join(stageRoot, '.motrix-server-stage.json'), 'utf8')
    )
    const manifest = JSON.parse(
      await readFile(path.join(stageRoot, 'package.json'), 'utf8')
    )
    expect(result.manifest).toEqual(stage)
    expect(manifest).toEqual({
      name: '@motrix/server-runtime',
      productName: 'Motrix Fixture',
      version: '1.2.3',
      description: 'fixture',
      homepage: 'https://example.test',
      author: { name: 'Motrix' },
      license: 'MIT',
      private: true,
      type: 'module',
      main: 'dist/server/index.mjs',
      engines: { node: '>=24' },
      dependencies: {
        '@scope/pkg': '1.0.0',
        alpha: '1.0.0',
        gamma: '1.0.0',
      },
    })
    expect(stage.target).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      key: 'darwin-arm64',
    })
    expect(stage.externals.roots).toEqual(['@scope/pkg', 'alpha', 'gamma'])
    expect(stage.optionalOmissions).toEqual([
      { name: 'linux-only', requestedBy: 'alpha@1.0.0' },
      { name: 'missing-native', requestedBy: 'alpha@1.0.0' },
    ])
    expect(
      stage.packages.map(
        (entry: { name: string; version: string }) =>
          `${entry.name}@${entry.version}`
      )
    ).toEqual(
      expect.arrayContaining([
        '@scope/pkg@1.0.0',
        'alpha@1.0.0',
        'beta@1.0.0',
        'gamma@1.0.0',
        'shared@1.0.0',
        'shared@2.0.0',
      ])
    )
    expect(stage.inputFingerprints).toHaveLength(4)
    expect(
      await readFile(path.join(stageRoot, 'legal/notice.txt'), 'utf8')
    ).toBe('legal')
    await expect(stat(path.join(stageRoot, 'dist/main'))).rejects.toThrow()
    await expect(
      stat(path.join(stageRoot, 'node_modules/unrelated'))
    ).rejects.toThrow()
    expect(await listSymlinks(stageRoot)).toEqual([])
    expect((await stat(path.join(root, 'node_modules/alpha'))).mtimeMs).toBe(
      sourceTimestamp
    )
  })

  it('preserves the last valid stage after an input failure', async () => {
    const root = await createFixture()
    const options = {
      repoRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
      budgets: fixtureBudgets(),
    }
    await stageServerApp(options)
    await writeFixtureFile(root, 'dist/server-app/previous.txt', 'preserved')
    await rm(path.join(root, 'dist/server/index.mjs'))
    await expect(stageServerApp(options)).rejects.toThrow('missing build entry')
    expect(
      await readFile(path.join(root, 'dist/server-app/previous.txt'), 'utf8')
    ).toBe('preserved')
  })

  it('rejects a top-level symlink input and an output escape', async () => {
    const root = await createFixture()
    const external = await mkdtemp(path.join(os.tmpdir(), 'motrix-external-'))
    temporaryRoots.push(external)
    await writeFixtureFile(external, 'notice.txt', 'outside')
    await rm(path.join(root, 'legal/notice.txt'))
    await symlink(
      path.join(external, 'notice.txt'),
      path.join(root, 'legal/notice.txt')
    )
    await expect(
      stageServerApp({
        repoRoot: root,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('symlink')

    await expect(
      stageServerApp({
        repoRoot: root,
        outputDir: path.join(path.dirname(root), 'escaped-stage'),
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('must stay within repository root')
  })

  it('rejects a missing required dependency without emitting a stage', async () => {
    const root = await createFixture()
    await rm(path.join(root, 'node_modules/gamma'), { recursive: true })
    await expect(
      stageServerApp({
        repoRoot: root,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('runtime root gamma is not installed')
    await expect(stat(path.join(root, 'dist/server-app'))).rejects.toThrow()
  })
})
