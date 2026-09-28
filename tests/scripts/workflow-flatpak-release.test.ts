import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  with?: Record<string, unknown>
}

interface Workflow {
  on: Record<string, unknown>
  concurrency: Record<string, unknown>
  jobs: Record<
    string,
    {
      needs?: string | string[]
      uses?: string
      if?: string
      with?: Record<string, unknown>
      steps?: Step[]
    }
  >
}

const flatpak = load(
  readFileSync('.github/workflows/flatpak.yml', 'utf8')
) as Workflow
const release = load(
  readFileSync('.github/workflows/release.yml', 'utf8')
) as Workflow

describe('Flatpak release gate', () => {
  it('builds within the release run, after version preflight, and blocks assembly on failure', () => {
    expect(flatpak.on.workflow_call).toEqual({
      inputs: {
        'release-version': {
          description: expect.any(String),
          required: true,
          type: 'string',
        },
      },
    })
    expect(release.jobs.flatpak).toMatchObject({
      needs: 'preflight',
      uses: './.github/workflows/flatpak.yml',
      with: { 'release-version': `\${{ needs.preflight.outputs.version }}` },
    })
    expect(release.jobs.assemble?.needs).toContain('flatpak')
    expect(release.jobs.assemble?.if).toContain(
      "needs.flatpak.result == 'success'"
    )
    expect(flatpak.concurrency['cancel-in-progress']).toBe(
      `\${{ inputs.release-version == '' }}`
    )
    expect(flatpak.concurrency.group).toContain('github.workflow')
  })

  it('pins the source to the event revision and checks the preflight version', () => {
    const prepare = flatpak.jobs.sources?.steps?.find(
      (step) => step.name === 'Prepare checked-out source for Flatpak'
    )
    expect(prepare?.run).toContain('--ref "$GITHUB_SHA"')
    expect(prepare?.run).toContain('--version "$RELEASE_VERSION"')
    const builder = flatpak.jobs.build?.steps?.find(
      (step) => step.name === 'Build Flatpak bundle'
    )
    expect(builder?.with?.branch).toBe(`\${{ needs.sources.outputs.branch }}`)
  })

  it('uploads only after installed-bundle and native-messaging checks, including in PR CI', () => {
    const steps = flatpak.jobs.build?.steps ?? []
    const install = steps.findIndex(
      (step) => step.name === 'Smoke-test installed payload'
    )
    const companion = steps.findIndex(
      (step) =>
        step.name ===
        'Smoke-test Browser Native Messaging through the host companion'
    )
    const upload = steps.findIndex(
      (step) => step.name === 'Upload verified Flatpak release bundle'
    )
    expect(install).toBeGreaterThanOrEqual(0)
    expect(companion).toBeGreaterThan(install)
    expect(upload).toBeGreaterThan(companion)
    expect(steps[upload]?.if).toBeUndefined()
    expect(steps[upload]?.with).toMatchObject({
      name: `flatpak-release-\${{ matrix.electron_arch }}`,
      path: 'flatpak-release/*.flatpak',
      'if-no-files-found': 'error',
    })
    expect(
      steps.find((step) => step.name === 'Build Flatpak bundle')?.with?.[
        'upload-artifact'
      ]
    ).toBe(false)
    expect(steps[install]?.run).toContain('--show-ref')
    expect(steps[install]?.run).toContain(
      "root.find('releases/release').get('version') == sys.argv[2]"
    )
  })

  it('downloads both verified bundles into their matching Linux release inputs', () => {
    const steps = release.jobs.assemble?.steps ?? []
    for (const arch of ['x64', 'arm64']) {
      const download = steps.find(
        (step) => step.with?.name === `flatpak-release-${arch}`
      )
      expect(download?.uses).toMatch(/^actions\/download-artifact@/)
      expect(download?.with?.path).toBe(
        `release-input/release-input-linux-${arch}/flatpak`
      )
    }
    expect(release.jobs.publish?.needs).toContain('assemble')
    expect(release.jobs.publish?.if).toContain("github.event_name == 'push'")
  })
})
