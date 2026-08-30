import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bytesToMiB,
  packageNameFromSpecifier,
  parseTarget,
  sanitizeMachinePaths,
  stringifySortedJson,
  validateRuntimeDependencyContract,
  validateSizeBudgetContract,
} from '../../scripts/electron-package-utils.mjs'
import {
  parseSmokeArguments,
  resolvePackagedLayout,
  scanRuntimeLog,
} from '../../scripts/smoke-electron-package.mjs'
import { BUNDLED_PACKAGES } from '../../vite.main.config'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8')
  )
}

describe('Electron package contracts', () => {
  it('hydrates Electron before local commands consume its runtime files', async () => {
    const manifest = (await readJson('package.json')) as {
      scripts?: Record<string, string>
    }
    const scripts = manifest.scripts ?? {}

    expect(scripts['ensure:electron-runtime']).toBe(
      'node scripts/ensure-electron-runtime.mjs'
    )
    for (const scriptName of [
      'prestart',
      'build:legal',
      'check:registry-runtime',
      'check:third-party-notices',
      'pretest:e2e',
      'pretest:e2e:ui',
      'pretest:e2e:debug',
      'smoke:electron-package',
    ]) {
      expect(
        scripts[scriptName],
        `${scriptName} must hydrate Electron before consuming its runtime`
      ).toMatch(/^pnpm run ensure:electron-runtime && /)
    }
  })

  it('hydrates Electron when Playwright is invoked directly', async () => {
    const globalSetup = await readFile(
      path.join(REPOSITORY_ROOT, 'e2e/global-setup.ts'),
      'utf8'
    )

    expect(globalSetup).toContain("['run', 'ensure:electron-runtime']")
  })

  it('packages only the generated staged application', async () => {
    const config = (await readJson('electron-builder.json')) as {
      asarUnpack?: string[]
      beforeBuild?: string
      directories?: Record<string, string>
      files?: Array<string | { filter?: string[]; from?: string; to?: string }>
    }
    const manifest = (await readJson('package.json')) as {
      scripts?: Record<string, string>
    }

    expect(config.directories).toMatchObject({
      app: 'dist/electron-app',
      output: 'release',
      buildResources: 'build',
    })
    expect(
      config.files?.filter(
        (pattern) => typeof pattern === 'string' && !pattern.startsWith('!')
      )
    ).toEqual([
      '.motrix-package-stage.json',
      'dist/core/plugin/host/**',
      'dist/main/**',
      'dist/preload/**',
      'dist/renderer/**',
      'package.json',
    ])
    expect(config.files).toContainEqual({
      from: 'node_modules',
      to: 'node_modules',
      filter: [
        '**/*',
        '!**/*.map',
        '!**/*.ts',
        '!**/*.tsx',
        '!**/tsconfig*.json',
        '!**/biome.json',
        '!**/vite*.config.*',
      ],
    })
    expect(config.files).not.toContain('dist/**/*')
    expect(config.asarUnpack).toContain('dist/renderer/**')
    expect(config.asarUnpack).not.toContain(
      '**/node_modules/@resvg/resvg-wasm/**/*.wasm'
    )
    expect(config.beforeBuild).toBe(
      './scripts/before-build-use-staged-dependencies.mjs'
    )

    expect(manifest.scripts?.['stage:electron']).toBe(
      'node scripts/stage-electron-app.mjs'
    )
    expect(manifest.scripts?.['verify:electron-package']).toBe(
      'node scripts/verify-electron-package.mjs'
    )
    for (const name of ['pack:mac', 'dist:mac', 'release:mac']) {
      const command = manifest.scripts?.[name] ?? ''
      expect(command).toMatch(
        /build:mac-arm64 && pnpm run stage:electron -- --platform darwin --arch arm64 && .*electron-builder/
      )
    }
    expect(manifest.scripts?.['build:electron']).not.toContain('stage:electron')
  })

  it('keeps macOS bundle versions numeric while the app version stays SemVer', async () => {
    const manifest = (await readJson('package.json')) as { version?: string }
    const version = manifest.version ?? ''
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.\d+)?$/.exec(version)

    expect(match).not.toBeNull()
    const bundleShortVersion = match?.slice(1, 4).join('.')
    for (const configPath of [
      'electron-builder.json',
      'electron-builder.signing.json',
    ]) {
      const config = (await readJson(configPath)) as {
        mac?: { bundleShortVersion?: string; bundleVersion?: string }
      }
      expect(config.mac?.bundleShortVersion).toBe(bundleShortVersion)
      expect(config.mac?.bundleVersion).toMatch(/^\d+(?:\.\d+){0,2}$/)
    }
  })

  it('stages every externalized main-surface import as a runtime root', async () => {
    // vite.main.config.ts externalizes every production dependency (minus
    // BUNDLED_PACKAGES), so each bare runtime import under src/main,
    // src/core, or src/shared becomes a require() in dist/main/index.cjs —
    // and stage-electron-app.mjs only ships what the runtime contract
    // lists. A dependency present in package.json but absent from the
    // contract works in dev (full node_modules) and throws
    // MODULE_NOT_FOUND in the packaged app; @noble/hashes shipped exactly
    // that way.
    const manifest = (await readJson('package.json')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const productionDeps = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
    const contract = validateRuntimeDependencyContract(
      await readJson('scripts/electron-runtime-dependencies.json')
    )
    const staged = new Set([
      ...contract.common,
      ...Object.values(contract.platforms).flatMap((platform) => [
        ...platform.required,
        ...platform.optional,
      ]),
    ])

    const files: string[] = []
    for (const surface of ['src/main', 'src/core', 'src/shared']) {
      const entries = await readdir(path.join(REPOSITORY_ROOT, surface), {
        recursive: true,
        withFileTypes: true,
      })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!/\.tsx?$/.test(entry.name)) continue
        if (/\.(test|spec)\./.test(entry.name)) continue
        if (entry.parentPath.includes('__tests__')) continue
        files.push(path.join(entry.parentPath, entry.name))
      }
    }
    expect(files.length).toBeGreaterThan(100)

    // Static `import`/`export ... from` (skipping type-only statements —
    // verbatimModuleSyntax erases those) plus dynamic `import()`.
    const specifierPattern =
      /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^'"]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g
    const missing = new Map<string, string>()
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2]
        const name = packageNameFromSpecifier(specifier ?? '')
        if (name === undefined) continue
        // Aliases, devDependencies, electron, and bare builtins never
        // reach the packaged require path; bundled packages are inlined.
        if (!productionDeps.has(name)) continue
        if (BUNDLED_PACKAGES.includes(name)) continue
        if (!staged.has(name)) {
          missing.set(name, path.relative(REPOSITORY_ROOT, file))
        }
      }
    }

    expect(Object.fromEntries(missing)).toEqual({})
  })

  it('declares the exact supported runtime roots and targets', async () => {
    const contract = validateRuntimeDependencyContract(
      await readJson('scripts/electron-runtime-dependencies.json')
    )
    const rootManifest = (await readJson('package.json')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }

    expect(contract).toEqual({
      schemaVersion: 1,
      supportedTargets: [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'win32-x64',
      ],
      common: [
        '@motrix/mdxp',
        '@motrix/nat',
        '@motrix/plugin-manifest-schema',
        '@noble/curves',
        '@noble/hashes',
        'ajv',
        'better-sqlite3',
        'chokidar',
        'electron-updater',
        'i18next',
        'libsodium-wrappers',
        'mmdb-lib',
        'proxy-chain',
        'quickjs-emscripten',
        'undici',
        'uuid',
        'vscode-jsonrpc',
        'write-file-atomic',
        'ws',
        'yauzl',
        'zod',
      ],
      platforms: {
        darwin: {
          optional: ['electron-liquid-glass'],
          required: ['@resvg/resvg-wasm'],
        },
        linux: { optional: [], required: [] },
        win32: { optional: [], required: [] },
      },
    })

    const declared = new Set([
      ...Object.keys(rootManifest.dependencies ?? {}),
      ...Object.keys(rootManifest.optionalDependencies ?? {}),
    ])
    const roots = [
      ...contract.common,
      ...Object.values(contract.platforms).flatMap((entry) => [
        ...entry.required,
        ...entry.optional,
      ]),
    ]
    expect(roots.every((name) => declared.has(name))).toBe(true)
  })

  it('declares only controllable-payload hard budgets', async () => {
    const raw = await readJson('scripts/electron-package-size-budgets.json')
    const contract = validateSizeBudgetContract(raw)

    expect(contract).toEqual({
      schemaVersion: 1,
      payloadBytes: 64 * 1024 * 1024,
      betterSqlite3Bytes: 4 * 1024 * 1024,
      unexpectedPackageNames: 0,
      foreignBetterSqlite3Prebuilds: 0,
      duplicateResvgWasmFiles: 0,
    })
    expect(JSON.stringify(raw)).not.toMatch(/locale|installer|dmg|zip/i)
  })

  it('rejects unknown contract keys and unsupported targets', () => {
    expect(() =>
      validateSizeBudgetContract({
        schemaVersion: 1,
        payloadBytes: 1,
        betterSqlite3Bytes: 1,
        unexpectedPackageNames: 0,
        foreignBetterSqlite3Prebuilds: 0,
        duplicateResvgWasmFiles: 0,
        localeBytes: 0,
      })
    ).toThrow('unknown key')
    expect(() => parseTarget({ platform: 'darwin', arch: 'ia32' })).toThrow(
      'unsupported Electron package target'
    )
  })

  it('provides deterministic path-safe reporting helpers', () => {
    expect(packageNameFromSpecifier('@scope/pkg/subpath')).toBe('@scope/pkg')
    expect(packageNameFromSpecifier('plain/subpath')).toBe('plain')
    expect(bytesToMiB(1_572_864)).toBe(1.5)
    expect(stringifySortedJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
      '{\n  "a": {\n    "b": 3,\n    "d": 2\n  },\n  "z": 1\n}\n'
    )
    expect(
      sanitizeMachinePaths('failed at /Users/example/project', [
        '/Users/example',
      ])
    ).toBe('failed at <home>/project')
  })

  it('defines an explicit host-native packaged runtime smoke contract', async () => {
    const manifest = (await readJson('package.json')) as {
      scripts?: Record<string, string>
    }

    expect(manifest.scripts?.['smoke:electron-package']).toBe(
      'pnpm run ensure:electron-runtime && node scripts/smoke-electron-package.mjs'
    )
    expect(
      parseSmokeArguments([
        '--',
        '--app-dir',
        'release/mac-arm64/Motrix.app',
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--ad-hoc-sign',
      ])
    ).toMatchObject({
      adHocSign: true,
      appDir: 'release/mac-arm64/Motrix.app',
      key: 'darwin-arm64',
    })
    expect(() =>
      parseSmokeArguments([
        '--app-dir',
        'release/mac-arm64/Motrix.app',
        '--platform',
        'darwin',
      ])
    ).toThrow('requires both --platform and --arch')
  })

  it('resolves packaged layouts and detects startup dependency failures', () => {
    expect(resolvePackagedLayout('/tmp/Motrix.app', 'darwin')).toEqual({
      appDir: '/tmp/Motrix.app',
      executable: '/tmp/Motrix.app/Contents/MacOS/Motrix',
      resources: '/tmp/Motrix.app/Contents/Resources',
    })
    expect(resolvePackagedLayout('/tmp/motrix-unpacked', 'linux')).toEqual({
      appDir: '/tmp/motrix-unpacked',
      executable: '/tmp/motrix-unpacked/motrix',
      resources: '/tmp/motrix-unpacked/resources',
    })
    expect(scanRuntimeLog('ready')).toEqual({
      moduleResolutionError: false,
      nativeAbiError: false,
    })
    expect(scanRuntimeLog("Error: Cannot find module 'zod'")).toMatchObject({
      moduleResolutionError: true,
    })
    expect(
      scanRuntimeLog('was compiled against a different Node.js version')
    ).toMatchObject({ nativeAbiError: true })
  })
})
