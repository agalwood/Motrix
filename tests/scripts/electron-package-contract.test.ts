import { readFile } from 'node:fs/promises'
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
  it('packages only the generated staged application', async () => {
    const config = (await readJson('electron-builder.json')) as {
      asarUnpack?: string[]
      directories?: Record<string, string>
      files?: string[]
    }
    const manifest = (await readJson('package.json')) as {
      scripts?: Record<string, string>
    }

    expect(config.directories).toMatchObject({
      app: 'dist/electron-app',
      output: 'release',
      buildResources: 'build',
    })
    expect(config.files?.filter((pattern) => !pattern.startsWith('!'))).toEqual(
      [
        '.motrix-package-stage.json',
        'dist/core/plugin/host/**',
        'dist/main/**',
        'dist/preload/**',
        'dist/renderer/**',
        'node_modules/**',
        'package.json',
      ]
    )
    expect(config.files).not.toContain('dist/**/*')
    expect(config.asarUnpack).toContain('dist/renderer/**')
    expect(config.asarUnpack).not.toContain(
      '**/node_modules/@resvg/resvg-wasm/**/*.wasm'
    )

    expect(manifest.scripts?.['stage:electron']).toBe(
      'node scripts/stage-electron-app.mjs'
    )
    for (const name of ['pack:mac', 'dist:mac', 'release:mac']) {
      const command = manifest.scripts?.[name] ?? ''
      expect(command).toMatch(
        /build:mac-arm64 && pnpm run stage:electron -- --platform darwin --arch arm64 && .*electron-builder/
      )
    }
    expect(manifest.scripts?.['build:electron']).not.toContain('stage:electron')
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
        'ajv',
        'better-sqlite3',
        'chokidar',
        'electron-updater',
        'i18next',
        'libsodium-wrappers',
        'mmdb-lib',
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
})
