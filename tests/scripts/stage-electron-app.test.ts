import {
  chmod,
  mkdir,
  mkdtemp,
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
})
