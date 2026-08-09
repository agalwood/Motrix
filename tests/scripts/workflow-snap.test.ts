import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface LooseRecord {
  [key: string]: unknown
}

const ROOT = process.cwd()
const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => unknown
const snapSource = readFileSync(
  path.join(ROOT, '.github/workflows/snap.yml'),
  'utf8'
)
const promotionSource = readFileSync(
  path.join(ROOT, '.github/workflows/snap-promote.yml'),
  'utf8'
)
const ciSource = readFileSync(
  path.join(ROOT, '.github/workflows/ci.yml'),
  'utf8'
)
const snapWorkflow = asRecord(parseYaml(snapSource), 'Snap workflow')
const promotionWorkflow = asRecord(
  parseYaml(promotionSource),
  'Snap promotion workflow'
)

describe('Snap build workflow contract', () => {
  it('builds exactly amd64 and arm64 on matching native Ubuntu runners', () => {
    const build = workflowJob(snapWorkflow, 'build')
    const strategy = asRecord(build.strategy, 'build strategy')
    const matrix = asRecord(strategy.matrix, 'build matrix')
    const include = arrayField(matrix, 'include').map((entry) =>
      asRecord(entry, 'matrix entry')
    )

    expect(include).toEqual([
      {
        snap_arch: 'amd64',
        electron_arch: 'x64',
        os: 'ubuntu-24.04',
        rust_target: 'x86_64-unknown-linux-musl',
        app_dir: 'release/linux-unpacked',
      },
      {
        snap_arch: 'arm64',
        electron_arch: 'arm64',
        os: 'ubuntu-24.04-arm',
        rust_target: 'aarch64-unknown-linux-musl',
        app_dir: 'release/linux-arm64-unpacked',
      },
    ])
    expect(stringField(build, 'runs-on')).toContain('matrix.os')
  })

  it('rebuilds Snap PRs when every packaged release input changes', () => {
    const triggers = asRecord(snapWorkflow.on, 'Snap triggers')
    const pullRequest = asRecord(triggers.pull_request, 'pull request trigger')
    const paths = arrayField(pullRequest, 'paths')

    expect(paths).toEqual(
      expect.arrayContaining([
        '.cargo/**',
        'scripts/**',
        'THIRD_PARTY_LICENSES/**',
        'THIRD_PARTY_NOTICES.md',
        'THIRD_PARTY_NOTICES.zh-CN.md',
      ])
    )
  })

  it('builds an unpacked app and never lets electron-builder publish', () => {
    const steps = jobSteps(workflowJob(snapWorkflow, 'build'))
    const builder = steps.find((step) =>
      stringField(step, 'run', '').includes('electron-builder')
    )
    expect(builder).toBeDefined()

    const command = stringField(builder as LooseRecord, 'run')
    expect(command).toContain('--linux')
    expect(command).toContain('--dir')
    expect(command).toContain(`--\${{ matrix.electron_arch }}`)
    expect(command).toContain('--publish never')

    const snapcraft = steps.find((step) =>
      stringField(step, 'uses', '').startsWith('snapcore/action-build@')
    )
    expect(snapcraft).toBeDefined()
    const inputs = asRecord(snapcraft?.with, 'Snapcraft action inputs')
    expect(stringField(inputs, 'path')).toContain('matrix.snap_arch')
    expect(inputs['build-info']).toBe(true)
    expect(stringField(inputs, 'snapcraft-channel')).toBe('9.x/stable')
  })

  it('keeps Store credentials out of every untrusted build step', () => {
    const jobs = workflowJobs(snapWorkflow)
    const preflight = asRecord(jobs.preflight, 'preflight job')
    const build = asRecord(jobs.build, 'build job')

    expect(JSON.stringify(preflight)).not.toContain('secrets.')
    expect(JSON.stringify(build)).not.toContain('secrets.')
    expect(build).not.toHaveProperty('environment')
    expect(snapSource).not.toContain('pull_request_target')
  })

  it('gates the Snap packaging and runtime contracts in general CI', () => {
    for (const test of [
      'src/main/bridge/snap-environment.test.ts',
      'tests/scripts/snap-artifact.test.ts',
      'tests/scripts/snap-build-set-release.test.ts',
      'tests/scripts/snap-project.test.ts',
      'tests/scripts/snap-store-channel.test.ts',
      'tests/scripts/workflow-snap.test.ts',
    ]) {
      expect(ciSource).toContain(test)
    }
  })

  it('publishes only protected tags through the edge environment', () => {
    const publish = workflowJob(snapWorkflow, 'publish-edge')
    const condition = stringField(publish, 'if')
    const environment = asRecord(publish.environment, 'publish environment')

    expect(condition).toContain("github.event_name == 'push'")
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(condition).toContain('github.ref_protected == true')
    expect(stringField(environment, 'name')).toBe('snap-store-edge')
    expect(jobNeeds(publish)).toEqual(
      expect.arrayContaining(['preflight', 'build'])
    )
    expect(publish['timeout-minutes']).toBeGreaterThanOrEqual(
      boundedStepMinutes(publish) + 30
    )

    const triggers = asRecord(snapWorkflow.on, 'Snap triggers')
    expect(asRecord(triggers.push, 'push trigger')).toEqual({
      tags: ['v*'],
    })
    expect(triggers).toHaveProperty('pull_request')
    expect(triggers).toHaveProperty('workflow_dispatch')
  })

  it('uploads before releasing only the captured exact edge revisions', () => {
    const steps = jobSteps(workflowJob(snapWorkflow, 'publish-edge'))
    const inspectionTools = steps.find(
      (step) => step.name === 'Install artifact inspection tools'
    )
    const completeness = steps.find(
      (step) => step.name === 'Verify complete upload set'
    )
    const upload = steps.find(
      (step) => step.name === 'Upload complete build set'
    )
    const release = steps.find(
      (step) => step.name === 'Release exact build set to edge'
    )
    const publicVerification = steps.find(
      (step) => step.name === 'Verify public edge channel'
    )
    const revisionRecord = steps.find(
      (step) => step.name === 'Preserve trusted revision record'
    )

    expect(stringField(inspectionTools as LooseRecord, 'run')).toContain(
      'squashfs-tools'
    )
    expect(steps.indexOf(inspectionTools as LooseRecord)).toBeLessThan(
      steps.indexOf(completeness as LooseRecord)
    )
    expect(stringField(completeness as LooseRecord, 'run')).toContain(
      `\${#snaps[@]} != 2`
    )
    expect(stringField(completeness as LooseRecord, 'run')).toContain(
      'for arch in amd64 arm64'
    )

    const uploadEnvironment = asRecord(upload?.env, 'upload environment')
    expect(
      stringField(uploadEnvironment, 'SNAPCRAFT_STORE_CREDENTIALS')
    ).toContain('secrets.SNAPCRAFT_STORE_CREDENTIALS')
    const uploadCommand = stringField(upload as LooseRecord, 'run')
    expect(uploadCommand).toContain('snapcraft upload "$snap"')
    expect(uploadCommand).not.toContain('--release')
    expect(uploadCommand).toContain('matchAll(/\\bRevision')
    expect(uploadCommand).toContain('SNAP_REVISION_FILE')

    const releaseCommand = stringField(release as LooseRecord, 'run')
    expect(release?.['timeout-minutes']).toBeGreaterThanOrEqual(45)
    expect(releaseCommand).toContain('release-snap-build-set.mjs')
    expect(releaseCommand).toContain('--channel latest/edge')
    expect(releaseCommand).toContain('--amd64-revision')
    expect(releaseCommand).toContain('--arm64-revision')
    expect(releaseCommand).toContain('--snapcraft /snap/bin/snapcraft')
    expect(releaseCommand).toContain('--snapcraft-timeout-ms 120000')
    expect(releaseCommand).not.toContain('snapcraft promote')
    expect(steps.indexOf(upload as LooseRecord)).toBeLessThan(
      steps.indexOf(release as LooseRecord)
    )

    const verification = stringField(publicVerification as LooseRecord, 'run')
    expect(verification).toContain('verify-snap-store-channel.mjs')
    expect(verification).toContain('--architectures amd64,arm64')
    expect(verification).toContain('--expected-revisions "$SNAP_REVISION_FILE"')
    expect(steps.indexOf(publicVerification as LooseRecord)).toBeLessThan(
      steps.indexOf(revisionRecord as LooseRecord)
    )
    const recordInputs = asRecord(
      revisionRecord?.with,
      'revision record inputs'
    )
    expect(stringField(recordInputs, 'name')).toContain('github.run_attempt')
    expect(stringField(recordInputs, 'path')).toContain('SNAP_REVISION_FILE')
  })
})

describe('Snap promotion workflow contract', () => {
  it('is manual-only, serialized with edge publication, and runs from main', () => {
    const triggers = asRecord(promotionWorkflow.on, 'promotion triggers')
    expect(Object.keys(triggers)).toEqual(['workflow_dispatch'])

    const concurrency = asRecord(
      promotionWorkflow.concurrency,
      'promotion concurrency'
    )
    expect(stringField(concurrency, 'group')).toBe('snap-store-publication')
    expect(concurrency['cancel-in-progress']).toBe(false)
    expect(snapSource).toContain("'snap-store-publication'")

    const preflight = workflowJob(promotionWorkflow, 'preflight')
    expect(preflight['timeout-minutes']).toBeGreaterThanOrEqual(15)
    const checkout = jobSteps(preflight).find(
      (step) => step.name === 'Checkout verification tools'
    )
    expect(asRecord(checkout?.with, 'preflight checkout inputs')).toMatchObject(
      {
        'fetch-depth': 0,
      }
    )
    const command = jobSteps(preflight)
      .map((step) => stringField(step, 'run', ''))
      .join('\n')
    expect(command).toContain('refs/heads/main')
    expect(command).toContain('RELEASE_REF_PROTECTED')
    expect(command).toContain('Prerelease versions cannot enter stable')
    expect(command).toContain('source_run_id must be a positive integer')
    expect(command).toContain('actions/workflows/snap.yml')
    expect(command).toContain("jq -r '.workflow_id'")
    expect(command).toContain('$expected_workflow_id')
    expect(command).toContain('^\\.github/workflows/snap\\.yml@.+$')
    expect(command).not.toContain(
      `test "$(jq -r '.path' <<< "$run_json")" = '.github/workflows/snap.yml'`
    )
  })

  it('maps candidate from edge and stable from candidate', () => {
    const preflight = workflowJob(promotionWorkflow, 'preflight')
    const channels = jobSteps(preflight).find(
      (step) => step.name === 'Validate protected main and channels'
    )
    const command = stringField(channels as LooseRecord, 'run')

    expect(command).toContain("source_channel='latest/edge'")
    expect(command).toContain("source_channel='latest/candidate'")
    expect(command).toContain(
      `echo "target_channel=latest/\${PROMOTION_TARGET}"`
    )
  })

  it('binds promotion to a trusted protected-tag revision artifact', () => {
    const preflight = workflowJob(promotionWorkflow, 'preflight')
    const promote = workflowJob(promotionWorkflow, 'promote')
    const sourceVerification = jobSteps(preflight).find(
      (step) => step.name === 'Verify trusted source revisions'
    )
    const download = jobSteps(preflight).find(
      (step) => step.name === 'Download trusted revision record'
    )

    expect(JSON.stringify(preflight)).not.toContain('secrets.')
    expect(stringField(sourceVerification as LooseRecord, 'run')).toContain(
      '--architectures amd64,arm64'
    )
    expect(stringField(sourceVerification as LooseRecord, 'run')).toContain(
      '--expected-revisions "$REVISION_FILE"'
    )
    const downloadInputs = asRecord(download?.with, 'download inputs')
    expect(stringField(downloadInputs, 'run-id')).toContain(
      'inputs.source_run_id'
    )
    expect(stringField(downloadInputs, 'name')).toContain(
      'inputs.source_run_attempt'
    )
    expect(stringField(downloadInputs, 'github-token')).toContain(
      'github.token'
    )

    const environment = asRecord(promote.environment, 'promotion environment')
    expect(stringField(environment, 'name')).toBe(
      `snap-store-\${{ inputs.target }}`
    )
    expect(JSON.stringify(promote)).toContain(
      'secrets.SNAPCRAFT_STORE_CREDENTIALS'
    )
    expect(promote['timeout-minutes']).toBeGreaterThanOrEqual(
      boundedStepMinutes(promote) + 30
    )
    const sourceReverification = jobSteps(promote).find(
      (step) => step.name === 'Reverify approved source revisions'
    )
    const sourceCommand = stringField(
      sourceReverification as LooseRecord,
      'run'
    )
    const release = jobSteps(promote).find(
      (step) => step.name === 'Release approved build set'
    )
    expect(release?.['timeout-minutes']).toBeGreaterThanOrEqual(45)
    expect(sourceCommand).toContain('--expected-amd64-revision')
    expect(sourceCommand).toContain('--expected-arm64-revision')
  })

  it('releases exact revisions without rebuilding or re-reading a source channel', () => {
    const promote = workflowJob(promotionWorkflow, 'promote')
    const source = JSON.stringify(promote)

    expect(source).toContain('release-snap-build-set.mjs')
    expect(source).toContain('--amd64-revision')
    expect(source).toContain('--arm64-revision')
    expect(source).toContain('--snapcraft-timeout-ms 120000')
    expect(source).not.toContain('snapcraft promote')
    expect(source).not.toContain('electron-builder')
    expect(source).not.toContain('snapcraft upload')
    expect(source).not.toContain('action-build')
    expect(source).toContain('verify-snap-store-channel.mjs')
    expect(source).toContain('--expected-amd64-revision')
    expect(source).toContain('--expected-arm64-revision')
  })
})

function asRecord(value: unknown, label: string): LooseRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as LooseRecord
}

function arrayField(record: LooseRecord, field: string): unknown[] {
  const value = record[field]
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`)
  }
  return value
}

function stringField(
  record: LooseRecord,
  field: string,
  fallback?: string
): string {
  const value = record[field]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
  return value
}

function workflowJobs(workflow: LooseRecord): LooseRecord {
  return asRecord(workflow.jobs, 'workflow jobs')
}

function workflowJob(workflow: LooseRecord, name: string): LooseRecord {
  return asRecord(workflowJobs(workflow)[name], `${name} job`)
}

function jobSteps(job: LooseRecord): LooseRecord[] {
  return arrayField(job, 'steps').map((step) => asRecord(step, 'workflow step'))
}

function jobNeeds(job: LooseRecord): string[] {
  if (typeof job.needs === 'string') return [job.needs]
  if (
    Array.isArray(job.needs) &&
    job.needs.every((dependency) => typeof dependency === 'string')
  ) {
    return job.needs
  }
  throw new TypeError('job needs must be a string or string array')
}

function boundedStepMinutes(job: LooseRecord): number {
  return jobSteps(job).reduce((total, step) => {
    const timeout = step['timeout-minutes']
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      throw new TypeError('every Store mutation job step must have a timeout')
    }
    return total + timeout
  }, 0)
}
