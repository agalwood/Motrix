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
const PROJECT_PACKAGE_JSON = path.resolve(__dirname, '../../../../package.json')
const CURRENT_PLUGIN_API_PACKAGE_JSON = path.resolve(
  __dirname,
  '../../../../node_modules/@motrix/plugin-api/package.json'
)
const TSC_CLI = path.resolve(
  __dirname,
  '../../../../node_modules/typescript/bin/tsc'
)

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

describe('@motrix/plugin-api fixtures', () => {
  it.each([
    { name: 'legacy Hook', root: LEGACY_SDK_FIXTURE_ROOT },
    { name: 'delivery', root: DELIVERY_SDK_FIXTURE_ROOT },
  ])('type-checks the $name fixture against the project SDK', ({ root }) => {
    const project = JSON.parse(readFileSync(PROJECT_PACKAGE_JSON, 'utf8')) as {
      devDependencies: Record<string, string>
    }
    const installed = JSON.parse(
      readFileSync(CURRENT_PLUGIN_API_PACKAGE_JSON, 'utf8')
    ) as {
      name: string
      version: string
    }
    expect(installed).toMatchObject({
      name: '@motrix/plugin-api',
      version: project.devDependencies['@motrix/plugin-api'],
    })
    expectFixtureToTypeCheck(root)
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
