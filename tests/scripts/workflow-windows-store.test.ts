// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript engine CLI intentionally has no declarations
import { parseArgs } from '../../scripts/fetch-engine.mjs'

const require = createRequire(import.meta.url)
const load = require('js-yaml').load as (source: string) => {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { type: string; default: boolean }>
    }
  }
  permissions: Record<string, string>
  jobs: Record<string, { steps: Array<Record<string, unknown>> }>
}
const workflowPath = '.github/workflows/windows-store.yml'

describe('Windows SDK validation workflow boundaries', () => {
  it('passes the locked engine target through its actual CLI parser', async () => {
    const workflow = load(await readFile(workflowPath, 'utf8'))
    const step = workflow.jobs['package-test'].steps.find(
      (step) => step.name === 'Fetch locked Windows engine'
    )
    const command = step?.run
    expect(typeof command).toBe('string')
    if (typeof command !== 'string') throw new Error('Engine command missing')
    const argv = command.trim().split(/\s+/)
    expect(argv.slice(0, 3)).toEqual(['pnpm', 'run', 'fetch:engine'])
    const parsed = parseArgs(argv.slice(3))
    expect(parsed.platform).toBe('win32')
    expect(parsed.arch).toBe('x64')
    expect(parsed.writeLock).toBe(false)
    expect(parsed.force).toBe(false)
  })

  it('keeps uploaded evidence confined to bounded text file types', async () => {
    const workflow = load(await readFile(workflowPath, 'utf8'))
    const uploads = workflow.jobs['package-test'].steps.filter(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/upload-artifact@')
    )
    expect(uploads).toHaveLength(1)
    const settings = uploads[0].with as {
      path: string
      'retention-days': number
    }
    const paths = settings.path.trim().split('\n')
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) {
      if (
        /^\$\{\{ runner\.temp \}\}\/motrix-store-startup-identity\/startup-identity-test\.json$/.test(
          path
        )
      )
        continue
      if (
        /^\$\{\{ runner\.temp \}\}\/motrix-store-identity-cases\/identity-cases\.json$/.test(
          path
        )
      )
        continue
      if (
        /^\$\{\{ runner\.temp \}\}\/(?:motrix-store-startup-identity\/native-alias-test|motrix-native-alias-probe\/unpackaged-probe)\.json$/.test(
          path
        )
      )
        continue
      if (
        /^\$\{\{ runner\.temp \}\}\/(?:motrix-store-browser-inventory|motrix-store-browser-registration-contracts|motrix-store-firefox-relay-contracts|motrix-store-firefox-relay\/(?:build-report|relay-contracts)|motrix-store-startup-identity\/(?:browser\/browser-report|main-runtime-report))\.json$/.test(
          path
        )
      )
        continue
      expect(path).toMatch(
        /^\$\{\{ runner\.temp \}\}\/motrix-windows-store\/(?:build|prepared|prepared\.sdk-output)\/\*\.(?:json|xml|log)$/
      )
    }
    expect(settings['retention-days']).toBe(14)
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('allows ephemeral test installation only through an explicit manual input', async () => {
    const workflow = load(await readFile(workflowPath, 'utf8'))
    expect(
      workflow.on.workflow_dispatch.inputs.test_startup_identity
    ).toMatchObject({ type: 'boolean', default: false })
    const steps = workflow.jobs['package-test'].steps.filter(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('test-windows-store-startup-identity.ps1')
    )
    const installation = steps.filter(
      (step) => step.name === 'Verify signed test startup identity'
    )
    expect(installation).toHaveLength(1)
    expect(installation[0].if).toBe(
      "github.event_name == 'workflow_dispatch' && (inputs.test_startup_identity || inputs.test_native_alias)"
    )
    const script = await readFile(
      'scripts/test-windows-store-startup-identity.ps1',
      'utf8'
    )
    expect(script).toContain("$env:GITHUB_EVENT_NAME -cne 'workflow_dispatch'")
    expect(script).toContain("$env:RUNNER_ENVIRONMENT -cne 'github-hosted'")
    expect(script).toContain('-KeyExportPolicy NonExportable')
    expect(script).toContain('-DeleteKey')
    expect(script).not.toMatch(
      /Export-(?:PfxCertificate|Pkcs12)|Set-(?:ExecutionPolicy|ItemProperty)|MOTRIX_BRIDGE_DATA_DIR|MOTRIX_USER_DATA/
    )
  })

  it('uses test identity, clean-checkout preparation and nonpublishing build commands', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = load(source)
    const runs = workflow.jobs['package-test'].steps
      .map((step) => step.run)
      .filter((run): run is string => typeof run === 'string')
      .join('\n')
    expect(runs).toContain("profile = 'test'")
    expect(runs).toContain("name = 'Motrix.Store.Test'")
    expect(runs).toContain(
      'scripts/prepare-windows-store-build.mjs --repo-root .'
    )
    expect(runs).toContain(
      "'scripts/prepare-windows-store-layout.mjs', '--repo-root', '.'"
    )
    expect(runs).toContain('--win --x64 --publish never')
    expect(source).not.toMatch(
      /secrets\.|New-SelfSignedCertificate|Add-AppxPackage|signtool\s+sign|git\s+tag|gh\s+release/
    )
  })

  it('keeps installed native observations read-only and separate from user acceptance', async () => {
    const source = await readFile(
      'scripts/test-windows-store-startup-identity.ps1',
      'utf8'
    )
    expect(source).toContain("'windows-package-readonly-integration'")
    expect(source).toContain("$stage = 'main-child-native-probe'")
    expect(source).toContain(
      'actualStartupMutationVerified = $false; defaultAppsUiVerified = $false'
    )
    expect(source).not.toContain('Invoke-ReadonlyNativeQuery')
    const probe = await readFile(
      'src/main/platform/windows-package-readonly-probe.ts',
      'utf8'
    )
    expect(probe).toContain("deps.requestStartup('startup_query')")
    expect(probe).toContain('await deps.queryAssociations()')
    expect(probe).not.toMatch(/startup_enable|startup_disable|main_launch/)
  })
  it('requires explicit alias diagnostics, rejects combined signed modes and keeps them out of ordinary builds', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = load(source)
    expect(
      workflow.on.workflow_dispatch.inputs.test_native_alias
    ).toMatchObject({ type: 'boolean', default: false })
    const step = workflow.jobs['package-test'].steps.find(
      (s) => s.name === 'Build fixed native alias diagnostics'
    )
    expect(step?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.test_native_alias"
    )
    expect(source).toContain("throw 'Select one signed diagnostic mode.'")
    expect(source).toContain(
      "$metadata['testDiagnostics'] = 'native-messaging-probe-v1'"
    )
    expect(source).toContain("@('--probe-build-dir', $env:MOTRIX_STORE_PROBE)")
  })

  it('requires opt-in alias mode for browser fixtures and uploads no registration receipts or profiles', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = load(source)
    expect(
      workflow.on.workflow_dispatch.inputs.test_native_browsers
    ).toMatchObject({
      type: 'boolean',
      default: false,
    })
    const relay = workflow.jobs['package-test'].steps.find(
      (step) => step.name === 'Build fixed Firefox diagnostic relay'
    )
    expect(relay?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.test_native_alias && inputs.test_native_browsers"
    )
    expect(source).toContain(
      "throw 'Browser diagnostics require the native alias mode.'"
    )
    const installation = await readFile(
      'scripts/test-windows-store-startup-identity.ps1',
      'utf8'
    )
    expect(installation).toContain(
      '$TestNativeBrowsers -and (-not $TestNativeAlias'
    )
    expect(installation).toContain("$stage = 'native-branded-browsers'")
    expect(installation).toContain('$browser.diagnosticProbeOnly -ne $true')
    expect(installation).toContain('$browser.mbp1Verified -ne $false')
    expect(installation).toContain(
      '$browser.windows11AcceptanceVerified -ne $false'
    )
    const upload = workflow.jobs['package-test'].steps.find(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/upload-artifact@')
    )
    if (!upload) throw new Error('Upload step missing')
    expect((upload.with as { path: string }).path).not.toMatch(
      /registration\/|receipt|host-manifest|profile|\.exe|\.zip|\.png|\.mp4|\.webm/
    )
  })

  it('requires an explicit main-runtime mode and pins verified real extension builds', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = load(source)
    expect(
      workflow.on.workflow_dispatch.inputs.test_main_runtime
    ).toMatchObject({ type: 'boolean', default: false })
    const checkout = workflow.jobs['package-test'].steps.find(
      (step) => step.name === 'Check out current Store extension source'
    )
    expect(checkout?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.test_main_runtime"
    )
    expect(checkout?.with).toMatchObject({
      repository: 'motrixapp/motrix-extension',
      ref: 'b7dfcc88743e36170a22f598d84109da46259042',
      'persist-credentials': false,
    })
    const build = workflow.jobs['package-test'].steps.find(
      (step) => step.name === 'Build and verify current Store extension'
    )
    expect(build?.run).toContain('pnpm install --frozen-lockfile')
    expect(build?.run).toContain('pnpm build:webstore')
    expect(build?.run).toContain('pnpm build:firefox')
    expect(source).toContain(
      "throw 'Main runtime checks require the native alias mode.'"
    )
    const wrapper = await readFile(
      'scripts/test-windows-store-startup-identity.ps1',
      'utf8'
    )
    expect(wrapper).toContain('$TestMainRuntime -and (-not $TestNativeAlias')
    expect(wrapper).toContain("$stage = 'native-main-runtime'")
    expect(wrapper).toContain(
      '$firefox.signedPersistentInstallationVerified -ne $false'
    )
    expect(wrapper).toContain(
      '$extension.serviceWorkerRestartReconnectVerified -ne $true'
    )
    expect(wrapper).toContain(
      '$protocol.protocolCancellationVerified -ne $true'
    )
    const driver = workflow.jobs['package-test'].steps.find(
      (step) => step.name === 'Prepare pinned Mozilla WebDriver'
    )
    expect(driver?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.test_main_runtime"
    )
    expect(driver?.run).toContain('geckodriver-v0.37.1-win64.zip')
    expect(driver?.run).toContain(
      'dfed9315abe8d2fbc1b6161a2ee8002452e79cf05ee92fdc653a4e26bc35edd8'
    )
    expect(driver?.run).not.toMatch(
      /secrets\.|ExecutionPolicy|Set-ItemProperty/
    )
  })
})
