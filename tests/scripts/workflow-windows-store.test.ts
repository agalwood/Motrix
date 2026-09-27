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
}>
const commands = steps.map((step) => step.run ?? '').join('\n')
const stepIndex = (name: string) =>
  steps.findIndex((step) => step.name === name)

describe('Windows Store SDK test workflow', () => {
  it('uses an isolated Windows job with read-only permissions and no signing or publishing', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on).not.toHaveProperty('pull_request_target')
    expect(workflow.on.pull_request.branches).toEqual(['main'])
    expect(job['runs-on']).toBe('windows-2025')
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.permissions).toBeUndefined()
    expect(source).not.toContain('secrets.')
    expect(commands).not.toMatch(
      /signtool|Add-AppxPackage|Import-PfxCertificate|Publish-Appx|gh release/i
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
    expect(source).not.toContain('inputs.')
  })

  it('builds and stages before invoking the complete directory config and SDK round trip', () => {
    const ordered = [
      'Install locked dependencies',
      'Prepare fixed test inputs',
      'Ensure Electron runtime',
      'Fetch Windows engine',
      'Build builtin plugins',
      'Build native host',
      'Build filesystem helper',
      'Test Windows platform helper',
      'Build Windows platform helper',
      'Build Electron application',
      'Stage Electron application',
      'Build isolated Windows directory',
      'Verify Windows platform runtime imports',
      'Reject startup operations without package identity',
      'Verify and assemble test layout',
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
  })

  it('uploads only named text evidence, never an unsigned package or image', () => {
    const uploads = steps.filter((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    )
    expect(uploads).toHaveLength(1)
    const paths = String(uploads[0]?.with?.path).trim().split('\n')
    expect(paths.length).toBeGreaterThan(0)
    for (const entry of paths) {
      expect(entry).toMatch(/\.(?:json|xml|log)$/)
      expect(entry).not.toContain('**')
    }
    expect(uploads[0]?.with?.['retention-days']).toBe(14)
  })
})
