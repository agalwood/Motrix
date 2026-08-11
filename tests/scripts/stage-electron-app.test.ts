import { createHash } from 'node:crypto'
import {
  chmod,
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
import { stageElectronApp } from '../../scripts/stage-electron-app.mjs'

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
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
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
    'module.exports = 1\n'
  )
}

function fixtureContract() {
  return {
    schemaVersion: 1,
    supportedTargets: [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ],
    common: ['@scope/pkg', 'alpha', 'gamma'],
    platforms: {
      darwin: { optional: ['optional-darwin'], required: [] },
      linux: { optional: [], required: [] },
      win32: { optional: [], required: [] },
    },
  }
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

async function createNativeFixture(): Promise<string> {
  const root = await createFixture()
  const rootManifestPath = path.join(root, 'package.json')
  const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'))
  rootManifest.dependencies['@resvg/resvg-wasm'] = '2.6.2'
  rootManifest.dependencies['better-sqlite3'] = '13.0.3'
  await writeFile(
    rootManifestPath,
    `${JSON.stringify(rootManifest, null, 2)}\n`
  )

  await writePackage(root, 'node_modules/better-sqlite3', {
    name: 'better-sqlite3',
    version: '13.0.3',
  })
  const sqliteManifestPath = path.join(
    root,
    'node_modules/better-sqlite3/package.json'
  )
  const sqliteManifest = JSON.parse(await readFile(sqliteManifestPath, 'utf8'))
  sqliteManifest.main = 'lib/index.js'
  await writeFile(
    sqliteManifestPath,
    `${JSON.stringify(sqliteManifest, null, 2)}\n`
  )
  await writeFixtureFile(root, 'node_modules/better-sqlite3/LICENSE', 'MIT')
  await writeFixtureFile(root, 'node_modules/better-sqlite3/lib/index.js')
  await writeFixtureFile(root, 'node_modules/better-sqlite3/src/leak.cc')
  await writeFixtureFile(root, 'node_modules/better-sqlite3/deps/leak.c')
  await writeFixtureFile(root, 'node_modules/better-sqlite3/binding.gyp')
  for (const target of [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]) {
    const separator = target.lastIndexOf('-')
    const platform = target.slice(0, separator)
    const arch = target.slice(separator + 1)
    await writeFixtureFile(
      root,
      `node_modules/better-sqlite3/prebuilds/${target}.node`,
      nativeHeader(platform, arch).toString('binary')
    )
    await writeFile(
      path.join(root, `node_modules/better-sqlite3/prebuilds/${target}.node`),
      nativeHeader(platform, arch)
    )
  }
  await writePackage(root, 'node_modules/@resvg/resvg-wasm', {
    name: '@resvg/resvg-wasm',
    version: '2.6.2',
  })
  await writeFixtureFile(
    root,
    'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    'package-copy'
  )
  await writeFixtureFile(root, 'extra/tray/resvg.wasm', 'resource-copy')
  await writeFixtureFile(
    root,
    'dist/main/index.cjs',
    "require('alpha/subpath')\nrequire('better-sqlite3')\n"
  )
  return root
}

function nativeContract() {
  const contract = fixtureContract()
  return {
    ...contract,
    common: ['@scope/pkg', 'alpha', 'better-sqlite3', 'gamma'],
    platforms: {
      ...contract.platforms,
      darwin: {
        optional: ['optional-darwin'],
        required: ['@resvg/resvg-wasm'],
      },
    },
  }
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-stage-test-'))
  temporaryRoots.push(root)

  await writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'motrix-fixture',
        productName: 'Motrix Fixture',
        version: '1.2.3',
        description: 'fixture',
        homepage: 'https://example.test',
        author: { name: 'Motrix' },
        license: 'MIT',
        type: 'module',
        main: 'dist/main/index.cjs',
        private: true,
        scripts: { forbidden: 'true' },
        devDependencies: { forbidden: '1.0.0' },
        dependencies: {
          '@scope/pkg': '1.0.0',
          alpha: '1.0.0',
          gamma: '1.0.0',
        },
        optionalDependencies: { 'optional-darwin': '1.0.0' },
      },
      null,
      2
    )}\n`
  )
  await writeFixtureFile(
    root,
    'dist/main/index.cjs',
    [
      "const alpha = require('alpha/subpath')",
      "// require('ignored-comment')",
      'const text = "require(\'ignored-string\')"',
      'module.exports = { alpha, text }',
    ].join('\n')
  )
  await writeFixtureFile(root, 'dist/preload/preload.cjs')
  await writeFixtureFile(
    root,
    'dist/core/plugin/host/quick-js-worker.cjs',
    "require('@scope/pkg')\n"
  )
  await writeFixtureFile(root, 'dist/renderer/index.html', '<main>ok</main>')

  await writePackage(root, 'node_modules/alpha', {
    name: 'alpha',
    version: '1.0.0',
    dependencies: { beta: '1.0.0', shared: '1.0.0' },
    optionalDependencies: { 'missing-native': '1.0.0' },
  })
  await writeFixtureFile(
    root,
    'node_modules/alpha/subpath.js',
    'module.exports = 1\n'
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
  return root
}

describe('stageElectronApp', () => {
  it('creates a deterministic minimal stage with nested dependency lookup', async () => {
    const root = await createFixture()
    await writeFixtureFile(root, 'dist/server/forbidden.mjs')
    await writeFixtureFile(root, 'dist/renderer-web/forbidden.js')
    await writeFixtureFile(root, 'dist/builtin-moext/forbidden.moext')
    await writeFixtureFile(root, 'dist/builtin-plugins/forbidden/index.js')
    const sourceTimestamp = (await stat(path.join(root, 'node_modules/alpha')))
      .mtimeMs

    const result = await stageElectronApp({
      repoRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
    })

    const stageManifest = JSON.parse(
      await readFile(
        path.join(root, 'dist/electron-app/.motrix-package-stage.json'),
        'utf8'
      )
    )
    const generatedManifest = JSON.parse(
      await readFile(path.join(root, 'dist/electron-app/package.json'), 'utf8')
    )
    expect(result.manifest).toEqual(stageManifest)
    expect(stageManifest.externals).toEqual(['@scope/pkg', 'alpha/subpath'])
    expect(
      stageManifest.packages.map((entry: { version: string }) => entry.version)
    ).toEqual(expect.arrayContaining(['1.0.0', '2.0.0']))
    expect(stageManifest.optionalOmissions).toEqual([
      { name: 'missing-native', requestedBy: 'alpha@1.0.0' },
      { name: 'optional-darwin', requestedBy: 'motrix-fixture@1.2.3' },
    ])
    expect(generatedManifest).toEqual({
      name: 'motrix-fixture',
      productName: 'Motrix Fixture',
      version: '1.2.3',
      description: 'fixture',
      homepage: 'https://example.test',
      author: { name: 'Motrix' },
      license: 'MIT',
      type: 'module',
      main: 'dist/main/index.cjs',
      private: true,
      dependencies: {
        '@scope/pkg': '1.0.0',
        alpha: '1.0.0',
        gamma: '1.0.0',
      },
      optionalDependencies: { 'optional-darwin': '1.0.0' },
    })
    await expect(
      stat(
        path.join(
          root,
          'dist/electron-app/node_modules/gamma/node_modules/shared/package.json'
        )
      )
    ).resolves.toBeDefined()
    await expect(
      stat(path.join(root, 'dist/electron-app/dist/server'))
    ).rejects.toThrow()
    expect((await stat(path.join(root, 'node_modules/alpha'))).mtimeMs).toBe(
      sourceTimestamp
    )
    expect(JSON.stringify(stageManifest)).not.toContain(root)

    const cleanRoot = await createFixture()
    const clean = await stageElectronApp({
      repoRoot: cleanRoot,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
    })
    expect(clean.manifest).toEqual(stageManifest)
  })

  it('keeps the previous stage byte-identical after validation fails', async () => {
    const root = await createFixture()
    await stageElectronApp({
      repoRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
    })
    const manifestPath = path.join(
      root,
      'dist/electron-app/.motrix-package-stage.json'
    )
    const previous = await readFile(manifestPath)
    await rm(path.join(root, 'dist/main/index.cjs'))

    await expect(
      stageElectronApp({
        repoRoot: root,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
      })
    ).rejects.toThrow('missing Electron build output')
    expect(await readFile(manifestPath)).toEqual(previous)
  })

  it('fails closed for missing dependencies and escaping symlinks', async () => {
    const missingRoot = await createFixture()
    await rm(path.join(missingRoot, 'node_modules/beta'), { recursive: true })
    await expect(
      stageElectronApp({
        repoRoot: missingRoot,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
      })
    ).rejects.toThrow('required dependency beta')

    const symlinkRoot = await createFixture()
    const outside = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-stage-outside-')
    )
    temporaryRoots.push(outside)
    await writeFixtureFile(outside, 'secret.txt', 'secret')
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(symlinkRoot, 'node_modules/alpha/escape.txt')
    )
    await expect(
      stageElectronApp({
        repoRoot: symlinkRoot,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
      })
    ).rejects.toThrow('escapes repository root')
  })

  it('requires an explicit supported target in strict mode', async () => {
    const root = await createFixture()
    await expect(
      stageElectronApp({
        repoRoot: root,
        strict: true,
        contract: fixtureContract(),
      })
    ).rejects.toThrow('requires both --platform and --arch')
    await expect(
      stageElectronApp({
        repoRoot: root,
        platform: 'win32',
        arch: 'arm64',
        strict: true,
        contract: fixtureContract(),
      })
    ).rejects.toThrow('unsupported Electron package target')
  })

  it('preserves executable source modes without emitting symlinks', async () => {
    const root = await createFixture()
    const executable = path.join(root, 'node_modules/alpha/tool')
    await writeFixtureFile(root, 'node_modules/alpha/tool', '#!/bin/sh\n')
    await chmod(executable, 0o755)
    await stageElectronApp({
      repoRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      strict: true,
      contract: fixtureContract(),
    })

    const copied = await stat(
      path.join(root, 'dist/electron-app/node_modules/alpha/tool')
    )
    expect(copied.mode & 0o111).not.toBe(0)
  })

  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ])('filters native and WASM content for %s-%s', async (platform, arch) => {
    const root = await createNativeFixture()
    const result = await stageElectronApp({
      repoRoot: root,
      platform,
      arch,
      strict: true,
      contract: nativeContract(),
    })
    const sqliteRoot = path.join(
      root,
      'dist/electron-app/node_modules/better-sqlite3'
    )
    expect(await readdir(path.join(sqliteRoot, 'prebuilds'))).toEqual([
      `${platform}-${arch}.node`,
    ])
    await expect(stat(path.join(sqliteRoot, 'src'))).rejects.toThrow()
    await expect(stat(path.join(sqliteRoot, 'deps'))).rejects.toThrow()
    await expect(stat(path.join(sqliteRoot, 'binding.gyp'))).rejects.toThrow()

    const resvgRoot = path.join(
      root,
      'dist/electron-app/node_modules/@resvg/resvg-wasm'
    )
    if (platform === 'darwin') {
      await expect(
        stat(path.join(resvgRoot, 'index.js'))
      ).resolves.toBeDefined()
      await expect(
        stat(path.join(resvgRoot, 'index_bg.wasm'))
      ).rejects.toThrow()
      expect(result.manifest.resvgWasmSha256).toBe(
        createHash('sha256').update('resource-copy').digest('hex')
      )
    } else {
      await expect(stat(resvgRoot)).rejects.toThrow()
      expect(result.manifest.resvgWasmSha256).toBeUndefined()
    }
  })

  it('rejects a filename-matched SQLite prebuild with the wrong header', async () => {
    const root = await createNativeFixture()
    await writeFile(
      path.join(
        root,
        'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'
      ),
      nativeHeader('darwin', 'x64')
    )
    await expect(
      stageElectronApp({
        repoRoot: root,
        platform: 'darwin',
        arch: 'arm64',
        strict: true,
        contract: nativeContract(),
      })
    ).rejects.toThrow('expected darwin-arm64')
  })
})
