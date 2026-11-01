import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('lets the CI planner schedule PR builds without duplicate triggers', () => {
    const triggers = asRecord(snapWorkflow.on, 'Snap triggers')
    expect(triggers).toHaveProperty('workflow_call')
    expect(triggers).not.toHaveProperty('pull_request')
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

  it('delegates only protected tags to the resumable publisher', () => {
    const publish = workflowJob(snapWorkflow, 'publish-edge')
    expect(publish.uses).toBe('./.github/workflows/snap-publish.yml')
    expect(jobNeeds(publish)).toEqual(['preflight', 'build'])
    expect(publish.if).toContain("github.event_name == 'push'")
    expect(publish.if).toContain('github.ref_protected == true')
    expect(publish.if).not.toContain('workflow_dispatch')
    expect(publish.secrets).toBe('inherit')
  })
})

const publicationWorkflow = asRecord(
  parseYaml(
    readFileSync(path.join(ROOT, '.github/workflows/snap-publish.yml'), 'utf8')
  ),
  'Snap artifact publication'
)

describe('Resumable Snap publication boundaries', () => {
  it('serializes Store operations while allowing failed uploads to resume independently', () => {
    expect(publicationWorkflow.concurrency).toEqual({
      group: 'snap-store-publication',
      'cancel-in-progress': false,
    })
    const upload = workflowJob(publicationWorkflow, 'upload')
    expect(upload.environment).toBe('snap-store-edge')
    expect(upload.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 1,
      matrix: { arch: ['amd64', 'arm64'] },
    })
    expect(jobNeeds(upload)).toEqual(['preflight'])
    const steps = jobSteps(upload)
    const lookup = steps.findIndex(
      (s) => s.name === 'Reconcile Store hash and upload at most once'
    )
    expect(
      steps.findIndex((s) => s.name === 'Verify edge credential scope')
    ).toBeLessThan(lookup)
    expect(
      steps.findIndex(
        (s) => s.name === 'Verify architecture package before Store access'
      )
    ).toBeLessThan(lookup)
    const record = steps.find(
      (s) => s.name === 'Preserve architecture receipt immediately'
    )
    expect(record?.if).toContain('always()')
    expect(asRecord(record?.with, 'receipt').name).toContain(
      'github.run_attempt'
    )
  })

  it('requires both receipts and Store revalidation before transactional edge release', () => {
    const publish = workflowJob(publicationWorkflow, 'publish-edge')
    expect(jobNeeds(publish)).toEqual(['preflight', 'upload'])
    const steps = jobSteps(publish)
    const release = steps.findIndex(
      (s) => s.name === 'Release exact build set to edge'
    )
    for (const name of [
      'Aggregate verified architecture receipts',
      'Validate scoped Store credential',
      'Reverify both Store hashes before changing edge',
    ]) {
      const index = steps.findIndex((s) => s.name === name)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(release)
    }
    expect(stringField(steps[release], 'run')).toContain(
      '--snapcraft-channel "$SNAPCRAFT_CHANNEL"'
    )
    expect(
      steps.findIndex((s) => s.name === 'Verify public edge channel')
    ).toBeLessThan(
      steps.findIndex((s) => s.name === 'Preserve trusted revision record')
    )
    expect(JSON.stringify(publish)).not.toContain('snapcraft upload')
  })
})

describe('Snap promotion workflow contract', () => {
  it('verifies target credential scope before any promotion mutation', () => {
    const steps = jobSteps(workflowJob(promotionWorkflow, 'promote'))
    const credentials = steps.find(
      (step) => step.name === 'Validate scoped Store credential'
    ) as LooseRecord
    const release = steps.find(
      (step) => step.name === 'Release approved build set'
    ) as LooseRecord
    expect(steps.indexOf(credentials)).toBeLessThan(steps.indexOf(release))
    expect(credentials['continue-on-error']).toBeUndefined()
    expect(credentials.id).toBe('credentials')
    expect(release.if).toBeUndefined()
    expect(stringField(credentials, 'run')).toContain(
      'python3 scripts/verify_snap_credential_scope.py'
    )
    expect(stringField(credentials, 'run')).toContain(
      '--channel "$TARGET_CHANNEL"'
    )
    expect(stringField(credentials, 'run')).toContain(
      '--github-output "$GITHUB_OUTPUT"'
    )
    expect(stringField(release, 'run')).toContain(
      '--snapcraft-channel "$SNAPCRAFT_CHANNEL"'
    )
    expect(asRecord(credentials.env, 'credential environment')).toMatchObject({
      SNAPCRAFT_STORE_CREDENTIALS: `\${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}`,
      TARGET_CHANNEL: `\${{ needs.preflight.outputs.target_channel }}`,
    })
    expect(asRecord(release.env, 'release environment')).toMatchObject({
      SNAPCRAFT_STORE_CREDENTIALS: `\${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}`,
      TARGET_CHANNEL: `\${{ needs.preflight.outputs.target_channel }}`,
      SNAPCRAFT_CHANNEL: `\${{ steps.credentials.outputs.snapcraft_channel }}`,
    })
  })

  it('is manual-only, serialized with edge publication, and runs from main', () => {
    const triggers = asRecord(promotionWorkflow.on, 'promotion triggers')
    expect(Object.keys(triggers)).toEqual(['workflow_dispatch'])

    const concurrency = asRecord(
      promotionWorkflow.concurrency,
      'promotion concurrency'
    )
    expect(stringField(concurrency, 'group')).toBe('snap-store-publication')
    expect(concurrency['cancel-in-progress']).toBe(false)
    expect(
      asRecord(publicationWorkflow.concurrency, 'publication lock').group
    ).toBe('snap-store-publication')

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
    expect(command).toContain(
      `"$workflow_path" != '.github/workflows/snap.yml'`
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

describe.skipIf(process.platform === 'win32')(
  'Snap promotion credential scope',
  () => {
    it.each([
      {
        output: snapWhoami('candidate'),
        diagnostic:
          'underlying error: private-account@example.test fixture-secret-do-not-print',
        exitCode: 23,
        reason: 'command_failed',
        recordValid: true,
        scopeStatus: 'scope_valid',
      },
      {
        output: snapWhoami('candidate'),
        diagnostic:
          'warning: private-account@example.test fixture-secret-do-not-print',
        exitCode: 0,
        reason: 'stderr_present',
        recordValid: true,
        scopeStatus: 'scope_valid',
      },
      {
        output: 'private-account@example.test fixture-secret-do-not-print',
        diagnostic: '',
        exitCode: 0,
        reason: 'scope_rejected',
        recordValid: false,
        scopeStatus: 'record_invalid',
      },
      {
        output: snapWhoami('candidate', 'package_access'),
        diagnostic: '',
        exitCode: 0,
        reason: 'scope_rejected',
        recordValid: true,
        scopeStatus: 'release_permission_denied',
      },
      {
        output: snapWhoami('edge'),
        diagnostic: '',
        exitCode: 0,
        reason: 'scope_rejected',
        recordValid: true,
        scopeStatus: 'destination_denied',
      },
    ])(
      'reports only safe diagnostics for $reason / $scopeStatus',
      (options) => {
        const result = runPromotionCredentialGate(options)
        expect(result.status).toBe(1)
        expect(result.releaseCalls).toEqual([])
        expect(result.githubOutput).toBe('')
        expect(result.snapcraftCalls).toEqual(['whoami --verbosity brief'])
        const diagnosticLines = result.stderr
          .split('\n')
          .filter((line) => line.startsWith('SNAP_CREDENTIAL_DIAGNOSTICS '))
        expect(diagnosticLines).toHaveLength(1)
        expect(
          JSON.parse(
            diagnosticLines[0].slice('SNAP_CREDENTIAL_DIAGNOSTICS '.length)
          )
        ).toEqual({
          reason: options.reason,
          returncode: options.exitCode,
          stdout_bytes: Buffer.byteLength(options.output),
          stderr_bytes: Buffer.byteLength(options.diagnostic),
          record_valid: options.recordValid,
          scope_status: options.scopeStatus,
        })
        for (const sensitive of [
          'private-account@example.test',
          'fixture-secret-do-not-print',
          'underlying error:',
          'warning:',
        ]) {
          expect(result.stdout + result.stderr).not.toContain(sensitive)
        }
      }
    )

    it.each(['candidate', 'stable'])(
      'rejects the observed edge credential before any %s mutation',
      (target) => {
        const result = runPromotionCredentialGate({
          target,
          channels: 'edge',
          permissions:
            'package_access, package_push, package_update, package_release',
        })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(
          `does not permit release to latest/${target}`
        )
        expect(result.snapcraftCalls).toEqual(['whoami --verbosity brief'])
        expect(result.releaseCalls).toEqual([])
      }
    )

    it.each([
      { target: 'candidate', channels: 'candidate' },
      { target: 'stable', channels: 'stable' },
      {
        target: 'candidate',
        channels: 'latest/candidate',
        selectedChannel: 'latest/candidate',
      },
      {
        target: 'stable',
        channels: 'latest/stable',
        selectedChannel: 'latest/stable',
      },
      {
        target: 'candidate',
        channels: 'latest/*',
        selectedChannel: 'latest/candidate',
      },
      { target: 'candidate', channels: 'latest/candidate, candidate' },
      { target: 'candidate', channels: 'edge, candidate, stable' },
      { target: 'stable', channels: 'no restrictions' },
      { target: 'candidate', channels: 'candi?ate' },
      { target: 'stable', channels: '*' },
      { target: 'stable', channels: '[cs]*' },
      {
        target: 'candidate',
        channels: 'candidate',
        permissions: 'package_upload',
      },
      { target: 'stable', channels: 'stable', permissions: 'no restrictions' },
      {
        target: 'stable',
        channels: 'edge,\n  candidate, stable',
        permissions: 'package_access,\n  package_release',
      },
    ])('accepts a scope covering the actual release request %j', (options) => {
      const result = runPromotionCredentialGate(options)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.snapcraftCalls).toEqual([
        'whoami --verbosity brief',
        'status motrix',
      ])
      expect(result.releaseCalls).toHaveLength(1)
      expect(result.releaseCalls[0]).toContain(
        `--channel latest/${options.target}`
      )
      const selectedChannel = options.selectedChannel ?? options.target
      expect(result.githubOutput).toBe(`snapcraft_channel=${selectedChannel}\n`)
      expect(result.releaseCalls[0]).toContain(
        `--snapcraft-channel ${selectedChannel} `
      )
    })

    it.each([
      { channels: 'candidate', target: 'stable' },
      { channels: '2.0/candidate' },
      { channels: 'latest/stable' },
      { channels: 'latest/candidate', target: 'stable' },
      { channels: 'latest/candidate/branch' },
      { channels: 'candidate/branch' },
      { channels: '[!cl]*' },
      { permissions: 'package_access, package_push' },
      { permissions: 'package_release_extra' },
      { permissions: '' },
      { channels: '' },
      { channels: 'no restrictions, edge' },
      { channels: 'edge,,candidate' },
      { output: '' },
      {
        output:
          'Log message mentions permissions: package_release and channels: candidate',
      },
      {
        output: snapWhoami('candidate').replace(
          'permissions: package_access, package_release\n',
          ''
        ),
      },
      { output: `${snapWhoami('edge')}\nchannels: candidate` },
      {
        output: `warning: credential scope may be stale\n${snapWhoami('candidate')}`,
      },
      {
        output: snapWhoami('candidate').replace(
          'channels: candidate',
          'channels: |\n  candidate'
        ),
      },
      { output: snapWhoami('candidate'), exitCode: 1 },
      { output: snapWhoami('candidate'), diagnostic: 'unexpected diagnostic' },
    ])(
      'rejects invalid or insufficient scope before entering the release helper %j',
      (options) => {
        const result = runPromotionCredentialGate(options)
        expect(result.status).not.toBe(0)
        expect(result.releaseCalls).toEqual([])
        expect(result.githubOutput).toBe('')
        expect(result.snapcraftCalls).toEqual(['whoami --verbosity brief'])
        expect(result.stdout + result.stderr).not.toContain(
          'private-account@example.test'
        )
        expect(result.stdout + result.stderr).not.toContain(
          'fixture-secret-do-not-print'
        )
        expect(result.stdout + result.stderr).not.toContain(
          'unexpected diagnostic'
        )
      }
    )
  }
)

function snapWhoami(
  channels: string,
  permissions = 'package_access, package_release'
) {
  return [
    'email: private-account@example.test',
    'username: fixture-account',
    'id: fixture-id',
    `permissions: ${permissions}`,
    `channels: ${channels}`,
    'expires: N/A',
  ].join('\n')
}

function runPromotionCredentialGate({
  target = 'candidate',
  channels = 'candidate',
  permissions = 'package_access, package_release',
  output = snapWhoami(channels, permissions),
  diagnostic = '',
  exitCode = 0,
}: {
  target?: string
  channels?: string
  permissions?: string
  output?: string
  diagnostic?: string
  exitCode?: number
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'motrix-snap-credential-'))
  const whoamiFile = path.join(root, 'whoami.txt')
  const snapcraftLog = path.join(root, 'snapcraft.log')
  const releaseLog = path.join(root, 'release.log')
  const githubOutput = path.join(root, 'github-output')
  writeFileSync(whoamiFile, output)
  writeFileSync(snapcraftLog, '')
  writeFileSync(releaseLog, '')
  writeFileSync(githubOutput, '')
  writeFileSync(
    path.join(root, 'snapcraft'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'%s\\n\' "$*" >> "$MOTRIX_TEST_SNAPCRAFT_LOG"',
      'case "$1" in',
      '  whoami) cat "$MOTRIX_TEST_WHOAMI_FILE"; printf \'%s\' "$MOTRIX_TEST_DIAGNOSTIC" >&2; exit "$MOTRIX_TEST_EXIT_CODE" ;;',
      '  status) exit 0 ;;',
      '  *) exit 98 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(root, 'node'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '[[ "$1" == scripts/release-snap-build-set.mjs ]] || exit 99',
      'printf \'%s\\n\' "$*" >> "$MOTRIX_TEST_RELEASE_LOG"',
    ].join('\n'),
    { mode: 0o755 }
  )
  const steps = jobSteps(workflowJob(promotionWorkflow, 'promote'))
  const credentials = steps.find(
    (step) => step.name === 'Validate scoped Store credential'
  ) as LooseRecord
  const release = steps.find(
    (step) => step.name === 'Release approved build set'
  ) as LooseRecord
  // A failed credential step prevents subsequent Actions steps. Transfer its
  // actual output to the release step as data, without evaluating shell text.
  const transferOutput = [
    'while IFS="=" read -r key value; do',
    '  [[ "$key" == snapcraft_channel ]] || exit 97',
    '  export SNAPCRAFT_CHANNEL="$value"',
    'done < "$GITHUB_OUTPUT"',
  ].join('\n')
  const command =
    `${stringField(credentials, 'run')}\n${transferOutput}\n${stringField(release, 'run')}`
      .replaceAll('/snap/bin/snapcraft', 'snapcraft')
      .replaceAll(`\${{ needs.preflight.outputs.amd64_revision }}`, '111')
      .replaceAll(`\${{ needs.preflight.outputs.arm64_revision }}`, '112')
  try {
    const result = spawnSync('bash', ['-c', command], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
        SNAPCRAFT_STORE_CREDENTIALS: 'fixture-secret-do-not-print',
        PROMOTION_TARGET: target,
        TARGET_CHANNEL: `latest/${target}`,
        EXPECTED_VERSION: '2.0.0',
        GITHUB_OUTPUT: githubOutput,
        MOTRIX_TEST_WHOAMI_FILE: whoamiFile,
        MOTRIX_TEST_DIAGNOSTIC: diagnostic,
        MOTRIX_TEST_EXIT_CODE: String(exitCode),
        MOTRIX_TEST_SNAPCRAFT_LOG: snapcraftLog,
        MOTRIX_TEST_RELEASE_LOG: releaseLog,
      },
    })
    return {
      ...result,
      githubOutput: readFileSync(githubOutput, 'utf8'),
      snapcraftCalls: readFileSync(snapcraftLog, 'utf8')
        .split('\n')
        .filter(Boolean),
      releaseCalls: readFileSync(releaseLog, 'utf8')
        .split('\n')
        .filter(Boolean),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The promotion job executes Bash and jq on Ubuntu; these fixtures exercise
// that exact script without contacting GitHub or modifying a Git checkout.
describe.skipIf(process.platform === 'win32')(
  'Snap promotion source validation',
  () => {
    it('accepts the canonical workflow-run API path and verifies the source tag ancestry', () => {
      const result = runPromotionSourceValidation()

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.gitCalls).toEqual([
        'fetch --no-tags origin refs/heads/main:refs/remotes/origin/main',
        'fetch --no-tags --force origin refs/tags/v2.0.0:refs/remotes/origin/snap-source-tag',
        'rev-parse refs/remotes/origin/snap-source-tag^{commit}',
        `merge-base --is-ancestor ${SNAP_SOURCE_SHA} refs/remotes/origin/main`,
      ])
    })

    it.each([
      '.github/workflows/snap.yml@refs/tags/v2.0.0',
      '.github/workflows/snap.yml.bak',
      '.github/workflows/release.yml',
      './.github/workflows/snap.yml',
      '.github/workflows/other/../snap.yml',
      '',
      null,
      undefined,
    ])(
      'rejects a noncanonical workflow path %j before fetching Git refs',
      (workflowPath) => {
        const result = runPromotionSourceValidation({ path: workflowPath })

        expect(result.status).not.toBe(0)
        expect(result.gitCalls).toEqual([])
      }
    )

    it.each([
      { event: 'workflow_dispatch' },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { workflow_id: 330566219 },
      { run_attempt: 2 },
      { head_repository: { full_name: 'untrusted/Motrix' } },
      { head_sha: 'invalid-sha' },
    ])(
      'rejects an untrusted source run %j before fetching Git refs',
      (overrides) => {
        const result = runPromotionSourceValidation(overrides)

        expect(result.status).not.toBe(0)
        expect(result.gitCalls).toEqual([])
      }
    )

    it('rejects a source SHA that differs from the requested release tag', () => {
      const result = runPromotionSourceValidation(
        {},
        { tagSha: 'b'.repeat(40) }
      )

      expect(result.status).not.toBe(0)
      expect(result.gitCalls.at(-1)).toBe(
        'rev-parse refs/remotes/origin/snap-source-tag^{commit}'
      )
    })

    it('rejects a source commit that is not on main', () => {
      const result = runPromotionSourceValidation({}, { onMain: false })

      expect(result.status).not.toBe(0)
      expect(result.gitCalls.at(-1)).toBe(
        `merge-base --is-ancestor ${SNAP_SOURCE_SHA} refs/remotes/origin/main`
      )
    })
  }
)

const SNAP_SOURCE_SHA = '954e62cef4819ff56506412f513ab75ff019c079'

function runPromotionSourceValidation(
  overrides: LooseRecord = {},
  { tagSha = SNAP_SOURCE_SHA, onMain = true } = {}
) {
  const root = mkdtempSync(path.join(tmpdir(), 'motrix-snap-source-'))
  const runPath = path.join(root, 'run.json')
  const workflowPath = path.join(root, 'workflow.json')
  const gitLog = path.join(root, 'git.log')
  // Minimal fields consumed from successful v2.0.0 Snap run 39989307936.
  writeFileSync(
    runPath,
    JSON.stringify({
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      workflow_id: 330566218,
      path: '.github/workflows/snap.yml',
      run_attempt: 1,
      head_repository: { full_name: 'agalwood/Motrix' },
      head_sha: SNAP_SOURCE_SHA,
      ...overrides,
    })
  )
  writeFileSync(workflowPath, JSON.stringify({ id: 330566218 }))
  writeFileSync(gitLog, '')
  writeFileSync(
    path.join(root, 'gh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case "$*" in',
      '  "api repos/agalwood/Motrix/actions/runs/39989307936") cat "$MOTRIX_SOURCE_RUN_FILE" ;;',
      '  "api repos/agalwood/Motrix/actions/workflows/snap.yml") cat "$MOTRIX_SOURCE_WORKFLOW_FILE" ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(root, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'%s\\n\' "$*" >> "$MOTRIX_SOURCE_GIT_LOG"',
      'case "$*" in',
      '  "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main") ;;',
      '  "fetch --no-tags --force origin refs/tags/v2.0.0:refs/remotes/origin/snap-source-tag") ;;',
      '  "rev-parse refs/remotes/origin/snap-source-tag^{commit}") printf \'%s\\n\' "$MOTRIX_SOURCE_TAG_SHA" ;;',
      '  "merge-base --is-ancestor $MOTRIX_SOURCE_RUN_SHA refs/remotes/origin/main") [[ "$MOTRIX_SOURCE_ON_MAIN" == true ]] ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 }
  )
  const step = jobSteps(workflowJob(promotionWorkflow, 'preflight')).find(
    (candidate) => candidate.name === 'Validate trusted source workflow run'
  )
  try {
    const result = spawnSync(
      'bash',
      ['-c', stringField(step as LooseRecord, 'run')],
      {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          EXPECTED_VERSION: '2.0.0',
          GITHUB_REPOSITORY: 'agalwood/Motrix',
          SOURCE_RUN_ID: '39989307936',
          SOURCE_RUN_ATTEMPT: '1',
          MOTRIX_SOURCE_RUN_FILE: runPath,
          MOTRIX_SOURCE_WORKFLOW_FILE: workflowPath,
          MOTRIX_SOURCE_GIT_LOG: gitLog,
          MOTRIX_SOURCE_TAG_SHA: tagSha,
          MOTRIX_SOURCE_RUN_SHA: SNAP_SOURCE_SHA,
          MOTRIX_SOURCE_ON_MAIN: String(onMain),
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      }
    )
    return {
      ...result,
      gitCalls: readFileSync(gitLog, 'utf8').split('\n').filter(Boolean),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
