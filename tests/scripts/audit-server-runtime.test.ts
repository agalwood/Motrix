import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build, type UserConfig } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { auditServerRuntime } from '../../scripts/audit-server-runtime.mjs'
import {
  externalPackageRoots,
  parseServerTarget,
  scanStaticModuleSpecifiers,
  validateServerRuntimeContract,
  validateServerSizeBudgets,
} from '../../scripts/server-package-utils.mjs'
import serverViteConfig from '../../vite.server.config'
import workerViteConfig from '../../vite.worker.config'

const ROOT = path.resolve(import.meta.dirname, '../..')
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

async function scanInMemoryBuild(config: UserConfig): Promise<string[]> {
  const result = await build({
    ...config,
    configFile: false,
    logLevel: 'silent',
    build: {
      ...config.build,
      emptyOutDir: false,
      write: false,
    },
  })
  if (!Array.isArray(result) && 'close' in result) {
    await result.close()
    throw new Error('unexpected Vite watch build')
  }

  const specifiers = new Set<string>()
  const outputs = Array.isArray(result) ? result : [result]
  for (const output of outputs) {
    for (const item of output.output) {
      if (item.type !== 'chunk') continue
      for (const specifier of scanStaticModuleSpecifiers(item.code)) {
        specifiers.add(specifier)
      }
    }
  }
  return [...specifiers].sort()
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
    runtimeRoots: ['alpha', 'beta'],
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
        source: 'extra/aria2.conf',
        destination: 'extra/aria2.conf',
        type: 'file',
      },
    ],
  }
}

function fixtureBudgets() {
  return {
    schemaVersion: 1,
    artifactBytes: 100,
    dependencyBytes: 80,
    packageInstances: 10,
    unexpectedRuntimeRoots: 0,
    unresolvedExternals: 0,
    foreignNativeBinaries: 0,
    betterSqlite3Prebuilds: 1,
  }
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-server-audit-'))
  temporaryRoots.push(root)
  await writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'server-audit-fixture',
        version: '1.2.3',
        dependencies: { alpha: '1.0.0', beta: '2.0.0', extra: '3.0.0' },
        optionalDependencies: { optional: '1.0.0' },
      },
      null,
      2
    )}\n`
  )
  await writeFixtureFile(
    root,
    'dist/server/index.mjs',
    [
      'import fs from "node:fs";',
      'import alpha from "alpha/subpath";',
      '// import ignored from "ignored-comment";',
      'const ignored = "require(\\"ignored-string\\")";',
      'export { alpha, ignored };',
    ].join('\n')
  )
  await writeFixtureFile(
    root,
    'dist/core/plugin/host/quick-js-worker.cjs',
    'module.exports = require("beta")\n'
  )
  await writeFixtureFile(
    root,
    'dist/renderer-web/index.html',
    '<main>ok</main>'
  )
  await writeFixtureFile(root, 'extra/aria2.conf', 'continue=true\n')
  for (const [name, version] of [
    ['alpha', '1.0.0'],
    ['beta', '2.0.0'],
  ]) {
    await writeFixtureFile(
      root,
      `node_modules/${name}/package.json`,
      `${JSON.stringify({ name, version, main: 'index.js' })}\n`
    )
    await writeFixtureFile(
      root,
      `node_modules/${name}/index.js`,
      'module.exports = true\n'
    )
  }
  await writeFixtureFile(
    root,
    'node_modules/alpha/subpath.js',
    'module.exports = true\n'
  )
  return root
}

describe('Server package contracts', () => {
  it('accepts the canonical target matrix and normalizes Docker arch aliases', () => {
    expect(
      parseServerTarget({
        platform: 'linux',
        arch: 'amd64',
        libc: 'musl',
        strict: true,
      })
    ).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'musl',
      key: 'linux-x64-musl',
    })
    expect(
      parseServerTarget({ platform: 'darwin', arch: 'arm64', strict: true })
    ).toEqual({ platform: 'darwin', arch: 'arm64', key: 'darwin-arm64' })
  })

  it('rejects ambiguous libc and unsupported targets', () => {
    expect(() =>
      parseServerTarget({ platform: 'linux', arch: 'arm64', strict: true })
    ).toThrow('requires --libc')
    expect(() =>
      parseServerTarget({
        platform: 'darwin',
        arch: 'arm64',
        libc: 'musl',
        strict: true,
      })
    ).toThrow('--libc is only valid')
    expect(() =>
      parseServerTarget({ platform: 'win32', arch: 'arm64', strict: true })
    ).toThrow('unsupported Server package target')
  })

  it('rejects unknown, unsorted, and unsafe contract data', () => {
    expect(validateServerRuntimeContract(fixtureContract())).toBeTruthy()
    expect(() =>
      validateServerRuntimeContract({ ...fixtureContract(), unknown: true })
    ).toThrow('unknown key')
    expect(() =>
      validateServerRuntimeContract({
        ...fixtureContract(),
        runtimeRoots: ['beta', 'alpha'],
      })
    ).toThrow('sorted order')
    const unsafe = fixtureContract()
    unsafe.resourceInputs[0].source = '../secret'
    expect(() => validateServerRuntimeContract(unsafe)).toThrow(
      'must stay within its root'
    )
    const duplicateDestination = fixtureContract()
    duplicateDestination.resourceInputs[0].destination =
      duplicateDestination.buildInputs[0].destination
    expect(() => validateServerRuntimeContract(duplicateDestination)).toThrow(
      'duplicate input destinations'
    )
    const unsortedEntries = fixtureContract()
    const serverInput = unsortedEntries.buildInputs[2] as {
      entry: string | string[] | null
    }
    serverInput.entry = ['motrix-admin.mjs', 'index.mjs']
    expect(() => validateServerRuntimeContract(unsortedEntries)).toThrow(
      'unique paths in sorted order'
    )
  })

  it('requires exact non-negative size budgets', () => {
    expect(validateServerSizeBudgets(fixtureBudgets())).toBeTruthy()
    expect(() =>
      validateServerSizeBudgets({
        ...fixtureBudgets(),
        artifactBytes: -1,
      })
    ).toThrow('non-negative safe integer')
    expect(() =>
      validateServerSizeBudgets({
        ...fixtureBudgets(),
        betterSqlite3Prebuilds: 2,
      })
    ).toThrow('must be 1')
  })

  it('freezes the reviewed build, resource, and runtime-root allowlists', async () => {
    const contract = validateServerRuntimeContract(
      JSON.parse(
        await readFile(
          path.join(ROOT, 'scripts/server-runtime-dependencies.json'),
          'utf8'
        )
      )
    )
    expect(contract.buildInputs.map((entry) => entry.source)).toEqual([
      'dist/core/plugin/host/quick-js-worker.cjs',
      'dist/renderer-web',
      'dist/server',
    ])
    expect(contract.buildInputs.at(-1)?.entry).toEqual([
      'index.mjs',
      'motrix-admin.mjs',
    ])
    expect(contract.resourceInputs.map((entry) => entry.source)).toEqual([
      'LICENSE',
      'THIRD_PARTY_LICENSES',
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_NOTICES.zh-CN.md',
      'build/legal/THIRD_PARTY_DEPENDENCIES.md',
      'build/legal/THIRD_PARTY_LICENSES.txt',
      'build/legal/sbom.spdx.json',
      'dist/builtin-plugins',
      'extra/aria2.conf',
      'extra/{platform}/{arch}/{aria2Binary}',
    ])
    expect(contract.runtimeRoots).toEqual([
      '@fastify/static',
      '@fastify/websocket',
      '@motrix/mdxp',
      '@motrix/plugin-manifest-schema',
      '@noble/curves',
      '@noble/hashes',
      'ajv',
      'better-sqlite3',
      'bittorrent-peerid',
      'chokidar',
      'fastify',
      'i18next',
      'libsodium-wrappers',
      'mmdb-lib',
      'parse-torrent',
      'pino',
      'proxy-chain',
      'quickjs-emscripten',
      'undici',
      'uuid',
      'vscode-jsonrpc',
      'write-file-atomic',
      'ws',
      'yauzl',
      'zod',
    ])
    expect(contract.runtimeRoots).not.toContain('electron-updater')
    expect(contract.runtimeRoots).not.toContain('@motrix/nat')
  })
})

describe('Server built external audit', () => {
  it('matches the actual Server and worker build externals to runtime roots', async () => {
    const contract = validateServerRuntimeContract(
      JSON.parse(
        await readFile(
          path.join(ROOT, 'scripts/server-runtime-dependencies.json'),
          'utf8'
        )
      )
    )
    const specifiers = new Set<string>()
    for (const config of [serverViteConfig, workerViteConfig]) {
      for (const specifier of await scanInMemoryBuild(config)) {
        specifiers.add(specifier)
      }
    }

    expect(externalPackageRoots([...specifiers])).toEqual(contract.runtimeRoots)
  })

  it('scans static ESM, side-effect, dynamic, export-from, and CJS imports', () => {
    const source = [
      'import value from "alpha/subpath";',
      'import "beta/register";',
      'export { thing } from "@scope/gamma/export";',
      'const delta = require("delta")',
      'const epsilon = import("epsilon")',
      '// require("ignored-comment")',
      'const ignored = "import(\\"ignored-string\\")"',
    ].join('\n')
    expect(scanStaticModuleSpecifiers(source)).toEqual([
      '@scope/gamma/export',
      'alpha/subpath',
      'beta/register',
      'delta',
      'epsilon',
    ])
    expect(
      externalPackageRoots([...scanStaticModuleSpecifiers(source), 'node:fs'])
    ).toEqual(['@scope/gamma', 'alpha', 'beta', 'delta', 'epsilon'])
  })

  it('does not lose imports after a regex literal containing quotes', () => {
    // Regression: bundle order shuffles could place guest-code rewrite
    // helpers (whose regex literals contain quote characters) before real
    // import statements; a tokenizer without regex-literal support started
    // a phantom string at the quote and desynchronized, dropping every
    // later specifier and mis-flagging pinned runtime roots as stale.
    const source = [
      String.raw`const stripped = code.replace(/\}\s*from\s*['"]motrix:plugin-api['"]\s*;?/g, patch);`,
      'const ratio = total / 2 / count;',
      'const halved = width() / 2;',
      'import * as schema from "@motrix/plugin-manifest-schema";',
      'export { audit } from "zeta/audit";',
    ].join('\n')
    expect(scanStaticModuleSpecifiers(source)).toEqual([
      '@motrix/plugin-manifest-schema',
      'zeta/audit',
    ])
  })

  it('measures reviewed inputs and rejects root drift', async () => {
    const root = await createFixture()
    const report = await auditServerRuntime({
      repoRoot: root,
      contract: fixtureContract(),
      budgets: fixtureBudgets(),
    })
    expect(report.rootVersion).toBe('1.2.3')
    expect(report.rootProductionDeclarations).toEqual({
      dependencies: 3,
      optionalDependencies: 1,
    })
    expect(report.externals.roots).toEqual(['alpha', 'beta'])
    expect(
      report.runtimeRoots.map((entry: { name: string }) => entry.name)
    ).toEqual(['alpha', 'beta'])
    expect(report.controlledInputs.build.files).toBe(3)
    expect(report.controlledInputs.resources.files).toBe(1)

    await writeFixtureFile(
      root,
      'dist/server/index.mjs',
      'import alpha from "alpha"; import gamma from "gamma";'
    )
    await expect(
      auditServerRuntime({
        repoRoot: root,
        contract: fixtureContract(),
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('unexpected runtime roots: gamma')
  })

  it('fails when an allowlisted build entry is missing', async () => {
    const root = await createFixture()
    await rm(path.join(root, 'dist/server/index.mjs'))
    await expect(
      auditServerRuntime({
        repoRoot: root,
        contract: fixtureContract(),
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('missing build entry: dist/server/index.mjs')
  })

  it('audits every declared entry in a multi-entry build directory', async () => {
    const root = await createFixture()
    await writeFixtureFile(
      root,
      'dist/server/motrix-admin.mjs',
      'import gamma from "gamma"; export default gamma;'
    )
    const contract = fixtureContract()
    const serverInput = contract.buildInputs[2] as {
      entry: string | string[] | null
    }
    serverInput.entry = ['index.mjs', 'motrix-admin.mjs']

    await expect(
      auditServerRuntime({
        repoRoot: root,
        contract,
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('unexpected runtime roots: gamma')

    await rm(path.join(root, 'dist/server/motrix-admin.mjs'))
    await expect(
      auditServerRuntime({
        repoRoot: root,
        contract,
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('missing build entry: dist/server/motrix-admin.mjs')
  })

  it('audits generated JavaScript chunks beside declared entries', async () => {
    const root = await createFixture()
    await writeFixtureFile(
      root,
      'dist/server/motrix-admin.mjs',
      'import path from "node:path"; export default path.sep;'
    )
    await writeFixtureFile(
      root,
      'dist/server/chunks/shared.mjs',
      'import gamma from "gamma"; export default gamma;'
    )
    const contract = fixtureContract()
    const serverInput = contract.buildInputs[2] as {
      entry: string | string[] | null
    }
    serverInput.entry = ['index.mjs', 'motrix-admin.mjs']

    await expect(
      auditServerRuntime({
        repoRoot: root,
        contract,
        budgets: fixtureBudgets(),
      })
    ).rejects.toThrow('unexpected runtime roots: gamma')
  })
})
