import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
    const stage = steps.find((step) =>
      stringField(step, 'run', '').includes('stage:electron')
    )
    const builder = steps.find((step) =>
      stringField(step, 'run', '').includes('electron-builder')
    )
    const verifier = steps.find((step) =>
      stringField(step, 'run', '').includes('verify-electron-package.mjs')
    )
    const prepare = steps.find(
      (step) => step.name === 'Prepare isolated Snapcraft project'
    )
    expect(stage).toBeDefined()
    expect(builder).toBeDefined()
    expect(verifier).toBeDefined()

    const command = stringField(builder as LooseRecord, 'run')
    expect(command).toContain('--linux')
    expect(command).toContain('--dir')
    expect(command).toContain(`--\${{ matrix.electron_arch }}`)
    expect(command).toContain('--publish never')
    const stageCommand = stringField(stage as LooseRecord, 'run')
    expect(stageCommand).toContain('--platform linux')
    expect(stageCommand).toContain(`--arch \${{ matrix.electron_arch }}`)
    const verifyCommand = stringField(verifier as LooseRecord, 'run')
    expect(verifyCommand).toContain(`--app-dir "\${{ matrix.app_dir }}"`)
    expect(verifyCommand).toContain('--platform linux')
    expect(verifyCommand).toContain(`--arch \${{ matrix.electron_arch }}`)
    expect(verifyCommand).toContain(
      `--report "release/size-reports/linux-\${{ matrix.electron_arch }}.json"`
    )
    expect(steps.indexOf(stage as LooseRecord)).toBeLessThan(
      steps.indexOf(builder as LooseRecord)
    )
    expect(steps.indexOf(builder as LooseRecord)).toBeLessThan(
      steps.indexOf(verifier as LooseRecord)
    )
    expect(steps.indexOf(verifier as LooseRecord)).toBeLessThan(
      steps.indexOf(prepare as LooseRecord)
    )

    const upload = steps.find((step) => step.name === 'Upload verified Snap')
    const uploadInputs = asRecord(upload?.with, 'Snap upload inputs')
    expect(stringField(uploadInputs, 'path')).toContain(
      `release/size-reports/linux-\${{ matrix.electron_arch }}.json`
    )
    expect(stringField(uploadInputs, 'if-no-files-found')).toBe('error')

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

  it('publishes protected tags and explicit protected-main recovery runs through the edge environment', () => {
    const preflight = workflowJob(snapWorkflow, 'preflight')
    const preflightOutputs = asRecord(preflight.outputs, 'preflight outputs')
    const build = workflowJob(snapWorkflow, 'build')
    const publish = workflowJob(snapWorkflow, 'publish-edge')
    const condition = stringField(publish, 'if')
    const environment = asRecord(publish.environment, 'publish environment')

    expect(stringField(preflightOutputs, 'version')).toBe(
      `\${{ steps.metadata.outputs.version }}`
    )
    expect(build).not.toHaveProperty('if')
    expect(condition).toContain("github.event_name == 'push'")
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(condition).toContain("github.event_name == 'workflow_dispatch'")
    expect(condition).toContain('inputs.publish_edge == true')
    expect(condition).toContain("github.ref == 'refs/heads/main'")
    expect(condition).toContain('github.ref_protected == true')
    expect(snapSource).not.toContain(
      "needs.preflight.outputs.prerelease == 'false'"
    )
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
    const manual = asRecord(
      triggers.workflow_dispatch,
      'workflow dispatch trigger'
    )
    const manualInputs = asRecord(manual.inputs, 'workflow dispatch inputs')
    expect(asRecord(manualInputs.publish_edge, 'publish edge input')).toEqual({
      description: 'Publish the protected main build to latest/edge',
      required: true,
      default: false,
      type: 'boolean',
    })
    const concurrency = asRecord(snapWorkflow.concurrency, 'Snap concurrency')
    expect(stringField(concurrency, 'group')).toContain(
      'inputs.publish_edge == true'
    )
    expect(stringField(concurrency, 'cancel-in-progress')).toContain(
      'inputs.publish_edge != true'
    )
  })

  it('installs pinned verifier dependencies before verification and Store mutation', () => {
    const steps = jobSteps(workflowJob(snapWorkflow, 'publish-edge'))
    const checkout = steps.find(
      (step) => step.name === 'Checkout verification tools'
    )
    const setupPnpm = steps.find(
      (step) => step.name === 'Setup pnpm for verification'
    )
    const setupNode = steps.find(
      (step) => step.name === 'Setup Node.js for verification'
    )
    const install = steps.find(
      (step) => step.name === 'Install verifier dependencies'
    )
    const download = steps.find(
      (step) => step.name === 'Download both architecture artifacts'
    )
    const completeness = steps.find(
      (step) => step.name === 'Verify complete upload set'
    )
    const credentialValidation = steps.find(
      (step) => step.name === 'Validate scoped Store credential'
    )

    expect(stringField(setupPnpm as LooseRecord, 'uses')).toBe(
      'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271'
    )
    expect(asRecord(setupPnpm?.with, 'pnpm setup inputs')).toEqual({
      version: '11.22.0',
      run_install: false,
    })
    expect(stringField(setupNode as LooseRecord, 'uses')).toBe(
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
    )
    expect(asRecord(setupNode?.with, 'Node setup inputs')).toEqual({
      'node-version': 24,
      cache: 'pnpm',
    })

    const installCommand = stringField(install as LooseRecord, 'run')
    expect(installCommand).toBe(
      'pnpm install --frozen-lockfile --ignore-scripts'
    )
    expect(asRecord(install?.env, 'verifier install environment')).toEqual({
      MOTRIX_SKIP_ELECTRON_REBUILD: '1',
      MOTRIX_SKIP_ENGINE_FETCH: '1',
    })

    expect(steps.indexOf(checkout as LooseRecord)).toBeLessThan(
      steps.indexOf(setupPnpm as LooseRecord)
    )
    expect(steps.indexOf(setupPnpm as LooseRecord)).toBeLessThan(
      steps.indexOf(setupNode as LooseRecord)
    )
    expect(steps.indexOf(setupNode as LooseRecord)).toBeLessThan(
      steps.indexOf(install as LooseRecord)
    )
    expect(steps.indexOf(install as LooseRecord)).toBeLessThan(
      steps.indexOf(download as LooseRecord)
    )
    expect(steps.indexOf(install as LooseRecord)).toBeLessThan(
      steps.indexOf(completeness as LooseRecord)
    )
    expect(steps.indexOf(completeness as LooseRecord)).toBeLessThan(
      steps.indexOf(credentialValidation as LooseRecord)
    )
    for (const mutation of [
      'Upload complete build set',
      'Release exact build set to edge',
    ]) {
      const mutationStep = steps.find((step) => step.name === mutation)
      expect(steps.indexOf(completeness as LooseRecord)).toBeLessThan(
        steps.indexOf(mutationStep as LooseRecord)
      )
    }
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
    const completenessCommand = stringField(completeness as LooseRecord, 'run')
    expect(completenessCommand).toContain('for arch in amd64 arm64')
    expect(completenessCommand).toContain('scripts/verify-snap-artifact.mjs')

    const uploadEnvironment = asRecord(upload?.env, 'upload environment')
    expect(
      stringField(uploadEnvironment, 'SNAPCRAFT_STORE_CREDENTIALS')
    ).toContain('secrets.SNAPCRAFT_STORE_CREDENTIALS')
    const uploadCommand = stringField(upload as LooseRecord, 'run')
    expect(uploadCommand).toContain(
      `release/snap-verified/motrix_verified_\${arch}.snap`
    )
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

  it('normalizes the real nested artifact layout into one exact verified set', () => {
    const fixture = createSnapUploadFixture()
    try {
      writeNestedSnap(
        fixture.root,
        'amd64',
        'motrix_2.0.0-beta.2_amd64.snap',
        'amd64-payload'
      )
      writeNestedSnap(
        fixture.root,
        'arm64',
        'motrix_2.0.0-beta.2_arm64.snap',
        'arm64-payload'
      )
      const reportDirectory = path.join(
        fixture.root,
        'release',
        'snap-upload',
        'size-reports'
      )
      mkdirSync(reportDirectory, { recursive: true })
      writeFileSync(path.join(reportDirectory, 'linux-x64.json'), '{}')

      const result = runSnapSetVerification(fixture)

      expect(result.status, result.stderr).toBe(0)
      const verifiedDirectory = path.join(
        fixture.root,
        'release',
        'snap-verified'
      )
      expect(readdirSync(verifiedDirectory).sort()).toEqual([
        'motrix_verified_amd64.snap',
        'motrix_verified_arm64.snap',
      ])
      expect(
        readFileSync(
          path.join(verifiedDirectory, 'motrix_verified_amd64.snap'),
          'utf8'
        )
      ).toBe('amd64-payload')
      expect(
        readFileSync(
          path.join(verifiedDirectory, 'motrix_verified_arm64.snap'),
          'utf8'
        )
      ).toBe('arm64-payload')
      expect(
        readFileSync(fixture.verificationLog, 'utf8').trim().split('\n')
      ).toEqual([
        'scripts/verify-snap-artifact.mjs --snap release/snap-upload/snap-amd64/motrix_2.0.0-beta.2_amd64.snap --arch amd64 --version 2.0.0-beta.2',
        'scripts/verify-snap-artifact.mjs --snap release/snap-upload/snap-arm64/motrix_2.0.0-beta.2_arm64.snap --arch arm64 --version 2.0.0-beta.2',
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'a missing architecture',
      prepare(root: string) {
        writeNestedSnap(
          root,
          'amd64',
          'motrix_2.0.0-beta.2_amd64.snap',
          'amd64'
        )
      },
      error: /Expected exactly two Snap artifacts, found 1/,
    },
    {
      label: 'an extra Snap',
      prepare(root: string) {
        writeNestedSnap(
          root,
          'amd64',
          'motrix_2.0.0-beta.2_amd64.snap',
          'amd64'
        )
        writeNestedSnap(
          root,
          'arm64',
          'motrix_2.0.0-beta.2_arm64.snap',
          'arm64'
        )
        writeFileSync(
          path.join(root, 'release', 'snap-upload', 'unexpected.snap'),
          'extra'
        )
      },
      error: /Expected exactly two Snap artifacts, found 3/,
    },
    {
      label: 'a duplicate basename',
      prepare(root: string) {
        for (const arch of ['amd64', 'arm64'] as const) {
          writeNestedSnap(root, arch, 'motrix_2.0.0-beta.2_amd64.snap', arch)
        }
      },
      error: /Duplicate Snap artifact basename/,
    },
    {
      label: 'an architecture-mismatched name',
      prepare(root: string) {
        writeNestedSnap(
          root,
          'amd64',
          'motrix_2.0.0-beta.2_amd64.snap',
          'amd64'
        )
        writeNestedSnap(
          root,
          'arm64',
          'motrix_2.0.0-beta.2_s390x.snap',
          'arm64'
        )
      },
      error: /Unexpected arm64 Snap artifact name/,
    },
  ])('rejects $label before upload', ({ prepare, error }) => {
    const fixture = createSnapUploadFixture()
    try {
      prepare(fixture.root)

      const result = runSnapSetVerification(fixture)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(error)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
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

interface SnapUploadFixture {
  root: string
  verificationLog: string
}

function createSnapUploadFixture(): SnapUploadFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'motrix-snap-workflow-'))
  const binaryDirectory = path.join(root, 'bin')
  const verificationLog = path.join(root, 'verification.log')
  // Dependency provisioning is covered by the static publish-edge contract;
  // this stub isolates artifact layout and verifier invocation behavior.
  const nodeStub = path.join(binaryDirectory, 'node')
  mkdirSync(binaryDirectory, { recursive: true })
  mkdirSync(path.join(root, 'release', 'snap-upload'), { recursive: true })
  writeFileSync(
    nodeStub,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> "$VERIFY_LOG"`,
      '',
    ].join('\n')
  )
  chmodSync(nodeStub, 0o755)
  return { root, verificationLog }
}

function writeNestedSnap(
  root: string,
  arch: 'amd64' | 'arm64',
  name: string,
  contents: string
): void {
  const directory = path.join(root, 'release', 'snap-upload', `snap-${arch}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, name), contents)
}

function runSnapSetVerification(fixture: SnapUploadFixture) {
  const completeness = jobSteps(workflowJob(snapWorkflow, 'publish-edge')).find(
    (step) => step.name === 'Verify complete upload set'
  )
  const command = stringField(completeness as LooseRecord, 'run')
  const binaryDirectory = path.join(fixture.root, 'bin')
  return spawnSync('bash', ['-c', command], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED_VERSION: '2.0.0-beta.2',
      PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
      VERIFY_LOG: fixture.verificationLog,
    },
  })
}

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
