import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')(
  'publishes only complete, verified fnOS packages from an exact stable release',
  () => {
    const result = spawnSync(
      'python3',
      ['tests/scripts/test_fnos_publication.py'],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      }
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
)

it('isolates fnOS build credentials from protected publication', () => {
  const workflow = load(
    readFileSync('.github/workflows/fnos-publish.yml', 'utf8')
  ) as {
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        needs?: string[] | string
        permissions?: Record<string, string>
        environment?: string
        steps: {
          name?: string
          uses?: string
          with?: Record<string, unknown>
        }[]
      }
    >
  }
  expect(workflow.permissions.contents).toBe('read')
  expect(workflow.jobs.build.permissions).toBeUndefined()
  expect(workflow.jobs.publish.permissions?.contents).toBe('write')
  expect(workflow.jobs.publish.environment).toBe('github-release')
  expect(workflow.jobs.publish.needs).toEqual(['preflight', 'build'])
  const checkout = workflow.jobs.build.steps[0]
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not JavaScript interpolation.
  expect(checkout.with?.ref).toBe('${{ needs.preflight.outputs.source_sha }}')
  expect(checkout.with?.['persist-credentials']).toBe(false)
  const artifacts = workflow.jobs.publish.steps.filter((step) =>
    step.uses?.startsWith('actions/download-artifact@')
  )
  expect(artifacts.map((step) => step.with?.name)).toEqual([
    'fnos-release-x64',
    'fnos-release-arm64',
  ])
})
