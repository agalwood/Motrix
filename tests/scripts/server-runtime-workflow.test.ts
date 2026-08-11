import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => unknown
const MATRIX_ARCH_EXPRESSION = '--platform linux/${' + '{ matrix.docker_arch }}'
const MATRIX_TARGET_EXPRESSION = '${' + '{ matrix.target }}'

interface Step {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface ServerRuntimeJob {
  name?: string
  'runs-on'?: string
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>
    }
  }
  steps?: Step[]
}

describe('Server runtime CI pipeline', () => {
  const source = readFileSync(
    path.join(ROOT, '.github/workflows/ci.yml'),
    'utf8'
  )
  const workflow = parseYaml(source) as {
    jobs?: Record<string, ServerRuntimeJob>
  }
  const job = workflow.jobs?.['server-runtime']
  const steps = job?.steps ?? []

  it('runs native x64 and arm64 Node 24 Docker jobs', () => {
    expect(job).toBeDefined()
    expect(job?.strategy?.matrix?.include).toEqual([
      {
        target: 'linux-x64-musl',
        os: 'ubuntu-22.04',
        docker_arch: 'amd64',
      },
      {
        target: 'linux-arm64-musl',
        os: 'ubuntu-22.04-arm',
        docker_arch: 'arm64',
      },
    ])
    expect(
      steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with
    ).toEqual({ 'node-version': 24 })
  })

  it('orders build, report export, runtime smoke, and artifact upload', () => {
    const names = steps.map((step) => step.name)
    const build = names.indexOf('Build staged Server image')
    const report = names.indexOf('Export Server size report')
    const smoke = names.indexOf('Smoke staged Server image')
    const upload = names.indexOf('Upload Server size report')
    expect(build).toBeGreaterThanOrEqual(0)
    expect(report).toBeGreaterThan(build)
    expect(smoke).toBeGreaterThan(report)
    expect(upload).toBeGreaterThan(smoke)

    expect(steps[build]?.run).toContain(MATRIX_ARCH_EXPRESSION)
    expect(steps[report]?.run).toContain('--target server-size-report')
    expect(steps[report]?.run).toContain(
      '--output type=local,dest=release/size-reports'
    )
    expect(steps[smoke]?.run).toContain('scripts/smoke-server-image.mjs')
    expect(steps[upload]?.with).toEqual(
      expect.objectContaining({
        name: `server-size-report-${MATRIX_TARGET_EXPRESSION}`,
        path: `release/size-reports/server-${MATRIX_TARGET_EXPRESSION}.json`,
        'if-no-files-found': 'error',
      })
    )
  })

  it('keeps package scripts and Docker regression assertions in CI', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    expect(manifest.scripts).toEqual(
      expect.objectContaining({
        'stage:server': 'node scripts/stage-server-app.mjs',
        'verify:server-package': 'node scripts/verify-server-package.mjs',
        'smoke:server-package': 'node scripts/smoke-server-package.mjs',
        'smoke:server-image': 'node scripts/smoke-server-image.mjs',
      })
    )
    const ciSteps = workflow.jobs?.ci?.steps ?? []
    const releaseContract = ciSteps.find(
      (step) => step.name === 'Release and packaging contracts'
    )
    expect(releaseContract?.run).toContain(
      'tests/scripts/docker-server-runtime.test.ts'
    )
    expect(releaseContract?.run).toContain(
      'tests/scripts/verify-server-package.test.ts'
    )
  })
})
