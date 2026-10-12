// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const load = require('js-yaml').load as (source: string) => {
  permissions: Record<string, string>
  jobs: Record<string, { steps: Array<Record<string, unknown>> }>
}
const workflowPath = '.github/workflows/windows-store.yml'

describe('Windows SDK validation workflow boundaries', () => {
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
      expect(path).toMatch(
        /^\$\{\{ runner\.temp \}\}\/motrix-windows-store\/(?:build|prepared|prepared\.sdk-output)\/\*\.(?:json|xml|log)$/
      )
    }
    expect(settings['retention-days']).toBe(14)
    expect(workflow.permissions).toEqual({ contents: 'read' })
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
})
