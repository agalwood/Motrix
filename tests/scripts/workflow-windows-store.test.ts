import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load
const source = readFileSync('.github/workflows/windows-store.yml', 'utf8')
const workflow = parseYaml(source)
const job = workflow.jobs['package-test']
const steps = job.steps as Array<{
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  if?: string
  shell?: string
  'continue-on-error'?: boolean
}>
const commands = steps.map((step) => step.run ?? '').join('\n')
const stepIndex = (name: string) =>
  steps.findIndex((step) => step.name === name)

describe('Windows Store SDK test workflow', () => {
  it('uses an isolated Windows job with read-only permissions and no release credentials or publishing', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on).not.toHaveProperty('pull_request_target')
    expect(workflow.on.pull_request.branches).toEqual(['main'])
    expect(workflow.on.pull_request.paths).toContain(
      'src/shared/config/windows-package.json'
    )
    expect(job['runs-on']).toBe('windows-2025')
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.permissions).toBeUndefined()
    const rust = steps.find((step) =>
      step.uses?.startsWith('dtolnay/rust-toolchain@')
    )
    expect(rust?.with?.components).toBe('rustfmt, clippy')
    expect(source).not.toContain('secrets.')
    expect(commands).not.toMatch(
      /signtool\s+sign|Add-AppxPackage|Import-PfxCertificate|Publish-Appx|gh release/i
    )
    expect(commands).not.toMatch(/--publish\s+(?:always|onTag)/)
    const checkout = steps.find((step) =>
      step.uses?.startsWith('actions/checkout@')
    )
    if (!checkout) throw new Error('Missing checkout step')
    expect(checkout.with?.['persist-credentials']).toBe(false)
    const lineEndings = stepIndex(
      'Configure deterministic checkout line endings'
    )
    expect(lineEndings).toBeGreaterThanOrEqual(0)
    expect(lineEndings).toBeLessThan(steps.indexOf(checkout))
    expect(steps[lineEndings]?.run).toBe(
      'git config --global core.autocrlf false'
    )
    for (const step of steps.filter((step) => step.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it('builds the production extension from one immutable source without publishing its profile or build', () => {
    const checkout = steps[stepIndex('Check out production extension source')]
    const build = steps[stepIndex('Build and verify production extension')]
    expect(checkout?.with?.repository).toBe('motrixapp/motrix-extension')
    expect(checkout?.with?.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(checkout?.with?.['persist-credentials']).toBe(false)
    const extensionPath = String(checkout?.with?.path)
    expect(
      execFileSync('git', ['check-ignore', '--no-index', extensionPath], {
        encoding: 'utf8',
      }).trim()
    ).toBe(extensionPath)
    expect(build?.run).toContain(checkout?.with?.ref)
    expect(build?.run).toContain('pnpm install --frozen-lockfile')
    expect(build?.run).toContain('pnpm build:webstore')
    expect(build?.run).toContain('pnpm build:firefox')
    expect(build?.run).toContain('MOTRIX_STORE_FIREFOX_EXTENSION_DIRECTORY=')
    expect(build?.run).toContain('git status --porcelain')
    expect(build?.run).toContain('MOTRIX_STORE_EXTENSION_COMMIT=')
    const upload = steps[stepIndex('Upload SDK text evidence')]
    expect(upload?.with?.path).not.toMatch(
      /store-extension-source|production-extension-profile/
    )
  })

  it('limits installed-package testing to manual dispatch after both SDK and PRI checks', () => {
    const index = stepIndex(
      'Test installed diagnostic alias and browsers on the hosted runner'
    )
    expect(index).toBeGreaterThan(
      stepIndex('Build and check the diagnostic upgrade package')
    )
    expect(index).toBeLessThan(stepIndex('Upload SDK text evidence'))
    const runtime = steps[index]
    expect(runtime?.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(runtime?.shell).toBe('powershell')
    expect(workflow.on.workflow_dispatch.inputs.protocol_browser).toEqual({
      description: 'Browser to verify for explicit Store URI cold launch',
      required: true,
      default: 'edge',
      type: 'choice',
      options: ['edge', 'chrome'],
    })
    expect(runtime?.env?.MOTRIX_STORE_PROTOCOL_BROWSER).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not JavaScript interpolation.
      "${{ inputs.protocol_browser || 'edge' }}"
    )
    expect(runtime?.['continue-on-error']).toBeUndefined()
    expect(runtime?.run).toContain(
      './scripts/test-windows-store-package-runtime.ps1'
    )
    expect(runtime?.run).toContain(
      '-PreparedDirectory $env:MOTRIX_STORE_DIAGNOSTIC_LAYOUT'
    )
    expect(runtime?.run).toContain(
      '-UpgradePreparedDirectory $env:MOTRIX_STORE_UPGRADE_LAYOUT'
    )
    expect(runtime?.run).toContain('-SdkBinDirectory $env:MOTRIX_STORE_SDK_BIN')
    expect(runtime?.run).toContain(
      "-OutputDirectory (Join-Path $env:RUNNER_TEMP 'motrix-store-alias-runtime')"
    )
    const sdk =
      steps[stepIndex('Build PRI and pack/unpack with Windows SDK')]?.run
    expect(sdk).toContain('MOTRIX_STORE_SDK_BIN=')
    const parse = steps[stepIndex('Parse SDK scripts with PowerShell')]?.run
    expect(parse).toContain('scripts/test-windows-store-package-runtime.ps1')
  })

  it('prepares an increasing diagnostic version and checks its SDK output before manual installation', () => {
    const index = stepIndex('Build and check the diagnostic upgrade package')
    expect(index).toBeGreaterThan(
      stepIndex('Exercise diagnostic PRI rejection cases')
    )
    const upgrade = steps[index]
    expect(upgrade?.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(upgrade?.['continue-on-error']).toBeUndefined()
    expect(upgrade?.run).toContain(
      'MOTRIX_STORE_DIAGNOSTIC_LAYOUT/release-metadata.json'
    )
    expect(upgrade?.run).toContain("$metadata.packageVersion -cne '1.0.0.0'")
    expect(upgrade?.run).toContain(
      '$metadata.previousPackageVersions = @($metadata.packageVersion)'
    )
    expect(upgrade?.run).toContain("$metadata.packageVersion = '1.0.1.0'")
    expect(upgrade?.run).toContain(
      '--app-dir "$env:MOTRIX_STORE_BUILD/payload/win-unpacked"'
    )
    expect(upgrade?.run).toContain('--probe-build-dir $probe')
    const prepareAt =
      upgrade?.run?.indexOf('prepare-windows-store-layout.mjs') ?? -1
    const sdkAt = upgrade?.run?.indexOf('pack-windows-store-test.ps1') ?? -1
    const priAt = upgrade?.run?.indexOf('windows-store-pri.test.ps1') ?? -1
    const exportAt = upgrade?.run?.indexOf('MOTRIX_STORE_UPGRADE_LAYOUT=') ?? -1
    expect(prepareAt).toBeGreaterThan(0)
    expect(sdkAt).toBeGreaterThan(prepareAt)
    expect(priAt).toBeGreaterThan(sdkAt)
    expect(exportAt).toBeGreaterThan(priAt)
  })

  it('runs pure upgrade guards under Windows PowerShell before package construction', () => {
    const index = stepIndex('Test runtime upgrade contracts')
    expect(index).toBeGreaterThan(
      stepIndex('Parse SDK scripts with PowerShell')
    )
    expect(index).toBeLessThan(
      stepIndex('Compile Native Messaging diagnostic probe')
    )
    const test = steps[index]
    expect(test?.shell).toBe('powershell')
    expect(test?.if).toBeUndefined()
    expect(test?.['continue-on-error']).toBeUndefined()
    expect(test?.run).toContain(
      'tests/scripts/windows-store-package-runtime.test.ps1'
    )
    expect(test?.run).toContain(
      "-ReportPath (Join-Path $env:RUNNER_TEMP 'motrix-store-runtime-contracts.json')"
    )
    expect(
      steps[stepIndex('Parse SDK scripts with PowerShell')]?.run
    ).toContain('tests/scripts/windows-store-package-runtime.test.ps1')
  })

  it('checks temporary registration ownership without enabling browser mutations in pull requests', () => {
    const index = stepIndex('Test temporary browser registration contracts')
    expect(index).toBeGreaterThan(
      stepIndex('Parse SDK scripts with PowerShell')
    )
    expect(index).toBeLessThan(
      stepIndex('Compile Native Messaging diagnostic probe')
    )
    const test = steps[index]
    expect(test?.shell).toBe('powershell')
    expect(test?.if).toBeUndefined()
    expect(test?.['continue-on-error']).toBeUndefined()
    expect(test?.run).toContain(
      'tests/scripts/windows-store-browser-registration.test.ps1'
    )
    expect(test?.run).toContain(
      "'motrix-store-browser-registration-contracts.json'"
    )
    expect(test?.run).toContain('if ($LASTEXITCODE -ne 0)')
    const parse = steps[stepIndex('Parse SDK scripts with PowerShell')]?.run
    expect(parse).toContain('scripts/windows-store-browser-registration.ps1')
    expect(parse).toContain(
      'tests/scripts/windows-store-browser-registration.test.ps1'
    )
    expect(commands).not.toMatch(
      /playwright\s+install|AllowTemporaryRegistration/
    )
  })

  it('binds fixed test metadata to the checkout without accepting production identity inputs', () => {
    const prepare = steps.find(
      (step) => step.name === 'Prepare fixed test inputs'
    )?.run
    expect(prepare).toContain('git rev-parse HEAD')
    expect(prepare).toContain('Get-Content -LiteralPath package.json')
    expect(prepare).toContain("profile = 'test'")
    expect(prepare).toContain("name = 'Motrix.Store.Test'")
    expect(prepare).toContain("publisher = 'CN=Motrix Store Test'")
    expect(prepare).toContain('prepare-windows-store-build.mjs')
    expect(prepare).not.toContain('inputs.')
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      'protocol_browser',
    ])
    expect(source.match(/inputs\.[a-z_]+/g)).toEqual([
      'inputs.protocol_browser',
    ])
  })

  it('compiles and exercises the diagnostic host outside the package before the SDK build', () => {
    const compileIndex = stepIndex('Compile Native Messaging diagnostic probe')
    const testIndex = stepIndex('Test direct Native Messaging probe framing')
    expect(compileIndex).toBeGreaterThan(
      stepIndex('Parse SDK scripts with PowerShell')
    )
    expect(testIndex).toBeGreaterThan(compileIndex)
    expect(testIndex).toBeLessThan(stepIndex('Prepare fixed test inputs'))
    const compile = steps[compileIndex]
    const test = steps[testIndex]
    expect(compile?.['continue-on-error']).toBeUndefined()
    expect(test?.['continue-on-error']).toBeUndefined()
    expect(compile?.run).toContain(
      './scripts/build-windows-store-native-messaging-probe.ps1'
    )
    expect(compile?.run).toContain(
      "-OutputDirectory (Join-Path $env:RUNNER_TEMP 'motrix-store-native-messaging-probe')"
    )
    expect(test?.run).toContain(
      './tests/scripts/windows-store-native-messaging-probe.test.ps1'
    )
    expect(test?.run).toContain(
      "-ProbePath (Join-Path $env:RUNNER_TEMP 'motrix-store-native-messaging-probe/motrix-store-p0-probe.exe')"
    )
    expect(test?.run).toContain(
      "-ReportPath (Join-Path $env:RUNNER_TEMP 'motrix-store-native-messaging-probe/direct-stdio-report.json')"
    )
    const parse = steps[stepIndex('Parse SDK scripts with PowerShell')]?.run
    expect(parse).toContain(
      'scripts/build-windows-store-native-messaging-probe.ps1'
    )
    expect(parse).toContain(
      'tests/scripts/windows-store-native-messaging-probe.test.ps1'
    )
    for (const trigger of [
      'tests/fixtures/windows-store-native-messaging/**',
      'scripts/*third-party-notices*',
      'THIRD_PARTY_LICENSES/**',
      'THIRD_PARTY_NOTICES*.md',
      'LICENSE',
      '.gitattributes',
    ]) {
      expect(workflow.on.pull_request.paths).toContain(trigger)
    }
  })

  it('builds and checks the fixed relay before the browser experiment and uploads text only', () => {
    const compile = steps[stepIndex('Compile Firefox diagnostic relay')]
    const check = steps[stepIndex('Test Firefox relay contracts')]
    expect(compile?.run).toContain(
      'scripts/build-windows-store-firefox-alias-relay.ps1'
    )
    expect(check?.run).toContain(
      'tests/scripts/windows-store-firefox-alias-relay.test.ps1'
    )
    expect(check?.run).toContain('motrix-store-p0-firefox-relay.exe')
    expect(stepIndex('Test Firefox relay contracts')).toBeGreaterThan(
      stepIndex('Compile Firefox diagnostic relay')
    )
    expect(stepIndex('Test Firefox relay contracts')).toBeLessThan(
      stepIndex('Prepare fixed test inputs')
    )
    expect(
      steps[
        stepIndex(
          'Test installed diagnostic alias and browsers on the hosted runner'
        )
      ]?.run
    ).toContain(
      "-FirefoxRelayBuildDirectory (Join-Path $env:RUNNER_TEMP 'motrix-store-firefox-relay')"
    )
    const paths = String(
      steps[stepIndex('Upload SDK text evidence')]?.with?.path
    )
    expect(paths).toContain('motrix-store-firefox-relay/build-report.json')
    expect(paths).toContain('motrix-store-firefox-relay/contracts-report.json')
  })

  it('runs the native host Windows tests before building its packaged executable', () => {
    const index = stepIndex('Test native host package profile contracts')
    expect(index).toBeGreaterThan(
      steps.findIndex((step) =>
        step.uses?.startsWith('dtolnay/rust-toolchain@')
      )
    )
    expect(index).toBeLessThan(stepIndex('Build native host'))
    const command = steps[index]?.run
    expect(command).toContain(
      'cargo clippy --manifest-path packages/native-host/Cargo.toml --all-targets --locked -- -D warnings'
    )
    expect(command).toContain(
      'cargo test --manifest-path packages/native-host/Cargo.toml --locked --all-targets'
    )
    expect(steps[index]?.['continue-on-error']).toBeUndefined()
  })

  it('builds and stages before invoking the complete directory config and SDK round trip', () => {
    const ordered = [
      'Install locked dependencies',
      'Prepare fixed test inputs',
      'Ensure Electron runtime',
      'Fetch Windows engine',
      'Build builtin plugins',
      'Test native host package profile contracts',
      'Build native host',
      'Build filesystem helper',
      'Test Windows platform helper',
      'Build Windows platform helper',
      'Build Electron application',
      'Stage Electron application',
      'Build isolated Windows directory',
      'Verify Windows platform runtime imports',
      'Reject platform operations without package identity',
      'Verify and assemble test layout',
      'Verify and assemble diagnostic test layout',
      'Build PRI and pack/unpack with Windows SDK',
    ].map(stepIndex)
    expect(ordered.every((index) => index >= 0)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    expect(commands).toContain('--frozen-lockfile')
    expect(commands).toContain(
      '--config "$env:MOTRIX_STORE_BUILD/electron-builder.json"'
    )
    expect(commands).toContain('--win --x64 --publish never')
    expect(commands).toContain('prepare-windows-store-layout.mjs')
    expect(commands).toContain('pack-windows-store-test.ps1')
    expect(commands).toContain(
      'pnpm run build:windows-platform --platform win32 --arch x64'
    )
    expect(commands).toContain(
      'payload/win-unpacked/resources/bin/motrix-windows-platform.exe'
    )
    expect(commands).not.toContain('--prepackaged')
    const negativeCheck = steps.find(
      (step) =>
        step.name === 'Reject platform operations without package identity'
    )?.run
    expect(negativeCheck).toContain(
      "@('startup_query', 'startup_enable', 'startup_disable', 'associations_query', 'main_launch')"
    )
    expect(negativeCheck).toContain("$reply.code -ne 'no_package_identity'")
  })

  it('packages ordinary and explicit diagnostic layouts from the same verified payload', () => {
    const diagnostic =
      steps[stepIndex('Verify and assemble diagnostic test layout')]?.run
    expect(diagnostic).toContain(
      "$metadata.testDiagnostics = 'native-messaging-probe-v1'"
    )
    expect(diagnostic).toContain('MOTRIX_STORE_BUILD/release-metadata.json')
    expect(diagnostic).toContain(
      '--app-dir "$env:MOTRIX_STORE_BUILD/payload/win-unpacked"'
    )
    expect(diagnostic).toContain('--probe-build-dir $probe')
    expect(diagnostic).toContain(
      "if ($LASTEXITCODE -ne 0) { throw 'Diagnostic test layout failed' }"
    )
    const sdk =
      steps[stepIndex('Build PRI and pack/unpack with Windows SDK')]?.run
    expect(sdk).toContain(
      '@($env:MOTRIX_STORE_LAYOUT, $env:MOTRIX_STORE_DIAGNOSTIC_LAYOUT)'
    )
    expect(
      steps[stepIndex('Exercise diagnostic PRI rejection cases')]?.run
    ).toContain('-PreparedDirectory $env:MOTRIX_STORE_DIAGNOSTIC_LAYOUT')
  })

  it('uploads only named text evidence, never a package, image, or certificate', () => {
    const uploads = steps.filter((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    )
    expect(uploads).toHaveLength(1)
    const paths = String(uploads[0]?.with?.path).trim().split('\n')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-runtime-contracts.json`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-browser-registration-contracts.json`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-alias-runtime/browser/browser-report.json`
    )
    expect(paths.filter((path) => path.includes('/browser/'))).toEqual([
      `\${{ runner.temp }}/motrix-store-alias-runtime/browser/browser-report.json`,
    ])
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-native-messaging-probe/build-report.json`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-native-messaging-probe/direct-stdio-report.json`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-alias-runtime/*.json`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-store-alias-runtime/*.log`
    )
    expect(paths).toContain(
      `\${{ runner.temp }}/motrix-windows-store-diagnostic-upgrade/prepared.sdk-output/*.json`
    )
    for (const entry of paths) {
      expect(entry).toMatch(/\.(?:json|xml|log)$/)
      expect(entry).not.toContain('**')
    }
    expect(uploads[0]?.with?.['retention-days']).toBe(14)
  })
})
