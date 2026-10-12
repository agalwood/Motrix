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
      "github.event_name == 'workflow_dispatch' && inputs.test_startup_identity"
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
      'scripts/prepare-windows-store-layout.mjs --repo-root .'
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
})
