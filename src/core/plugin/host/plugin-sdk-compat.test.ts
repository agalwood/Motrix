import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const LEGACY_SDK_FIXTURE_ROOT = path.resolve(
  __dirname,
  '../../../../tests/fixtures/plugins/test.hook-sdk-2-0'
)
const DELIVERY_SDK_FIXTURE_ROOT = path.resolve(
  __dirname,
  '../../../../tests/fixtures/plugins/test.hook-delivery-runtime'
)
const LEGACY_FIXTURE_PACKAGE_JSON = path.resolve(
  __dirname,
  '../../../../node_modules/@motrix/plugin-api-2-0/package.json'
)
const CURRENT_PLUGIN_API_PACKAGE_JSON = path.resolve(
  __dirname,
  '../../../../node_modules/@motrix/plugin-api/package.json'
)
const TSC_CLI = path.resolve(
  __dirname,
  '../../../../node_modules/typescript/bin/tsc'
)
const LOCKFILE = path.resolve(__dirname, '../../../../pnpm-lock.yaml')
const PLUGIN_API_2_1_INTEGRITY =
  'sha512-XJn8re75nGUFSOA9dsEAjFkj8FqY6pQMk5wnz9E7Ym+icOp7q0JChjS/ILETvsu1gmvntlzdzazmgi4U42fPIA=='

function expectFixtureToTypeCheck(fixtureRoot: string): void {
  expect(() =>
    execFileSync(
      process.execPath,
      [
        TSC_CLI,
        '-p',
        path.join(fixtureRoot, 'tsconfig.json'),
        '--pretty',
        'false',
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    )
  ).not.toThrow()
}

function buildFixtureSource(fixtureRoot: string): string {
  const buildScript = `
    import { build } from 'esbuild'
    const result = await build({
      entryPoints: [process.argv[1]],
      format: 'esm',
      logLevel: 'silent',
      platform: 'neutral',
      target: 'es2022',
      write: false,
    })
    process.stdout.write(result.outputFiles[0].text)
  `
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      buildScript,
      path.join(fixtureRoot, 'src/plugin.ts'),
    ],
    { encoding: 'utf8' }
  )
}

describe('@motrix/plugin-api compatibility fixtures', () => {
  it('type-checks the legacy 2.0 source fixture against the current 2.1 package', () => {
    const installed = JSON.parse(
      readFileSync(LEGACY_FIXTURE_PACKAGE_JSON, 'utf8')
    ) as {
      name: string
      version: string
    }
    expect(installed).toMatchObject({
      name: '@motrix/plugin-api',
      version: '2.1.0',
    })
    expect(readFileSync(LOCKFILE, 'utf8')).toContain(
      `'@motrix/plugin-api@2.1.0':\n    resolution: {integrity: ${PLUGIN_API_2_1_INTEGRITY}}`
    )

    expectFixtureToTypeCheck(LEGACY_SDK_FIXTURE_ROOT)
  })

  it('type-checks the delivery fixture against the current 2.1 feature API', () => {
    const installed = JSON.parse(
      readFileSync(CURRENT_PLUGIN_API_PACKAGE_JSON, 'utf8')
    ) as {
      name: string
      version: string
    }
    expect(installed).toMatchObject({
      name: '@motrix/plugin-api',
      version: '2.1.0',
    })
    expectFixtureToTypeCheck(DELIVERY_SDK_FIXTURE_ROOT)
  })

  it('keeps the committed QuickJS artifact byte-identical to the fixture source build', () => {
    expect(buildFixtureSource(LEGACY_SDK_FIXTURE_ROOT)).toBe(
      readFileSync(path.join(LEGACY_SDK_FIXTURE_ROOT, 'dist/plugin.js'), 'utf8')
    )
    expect(buildFixtureSource(DELIVERY_SDK_FIXTURE_ROOT)).toBe(
      readFileSync(
        path.join(DELIVERY_SDK_FIXTURE_ROOT, 'dist/plugin.js'),
        'utf8'
      )
    )
  })
})
