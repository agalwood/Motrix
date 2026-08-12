import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript build script intentionally has no declarations
import { BUILD_TARGETS } from '../../packages/native-host/build.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { RELEASE_TARGETS } from '../../scripts/assemble-release-artifacts.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { resolveReleaseMetadata } from '../../scripts/release-metadata.mjs'

interface LooseRecord {
  [key: string]: unknown
}

interface ExpectedTarget {
  key: string
  os: string
  platform: string
  arch: string
  rustTarget: string
}

const ROOT = process.cwd()
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github/workflows')
const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => unknown
const PNPM_VERSION = '11.18.0'
const PNPM_PACKAGE_MANAGER =
  'pnpm@11.18.0+sha512.33d83c77da82f49fba836925c6f1b841181ec3132b670639bd012f7075f5c7cf634c5f870147c19aae7478fac01df09d8892e880454896edd23ee9b33757563c'
const EXPECTED_ACTION_PINS = new Map([
  [
    'actions/checkout',
    {
      sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      comment: 'v7.0.1',
    },
  ],
  [
    'actions/setup-node',
    {
      sha: '820762786026740c76f36085b0efc47a31fe5020',
      comment: 'v7.0.0',
    },
  ],
  [
    'actions/upload-artifact',
    {
      sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      comment: 'v7.0.1',
    },
  ],
  [
    'actions/download-artifact',
    {
      sha: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      comment: 'v8.0.1',
    },
  ],
  [
    'pnpm/action-setup',
    {
      sha: '0ebf47130e4866e96fce0953f49152a61190b271',
      comment: 'v6.0.9',
    },
  ],
  [
    'dtolnay/rust-toolchain',
    {
      sha: '4cda84d5c5c54efe2404f9d843567869ab1699d4',
      comment: 'stable',
    },
  ],
  [
    'softprops/action-gh-release',
    {
      sha: '3d0d9888cb7fd7b750713d6e236d1fcb99157228',
      comment: 'v3.0.2',
    },
  ],
  [
    'snapcore/action-build',
    {
      sha: '3bdaa03e1ba6bf59a65f84a751d943d549a54e79',
      comment: 'v1',
    },
  ],
  [
    'flatpak/flatpak-github-actions/flatpak-builder',
    {
      sha: '401fe28a8384095fc1531b9d320b292f0ee45adb',
      comment: 'v6.7',
    },
  ],
  [
    'docker/setup-qemu-action',
    {
      sha: '96fe6ef7f33517b61c61be40b68a1882f3264fb8',
      comment: 'v4.2.0',
    },
  ],
  [
    'docker/setup-buildx-action',
    {
      sha: 'bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      comment: 'v4.2.0',
    },
  ],
  [
    'docker/login-action',
    {
      sha: 'dbcb813823bdd20940b903addbd779551569679f',
      comment: 'v4.6.0',
    },
  ],
  [
    'docker/build-push-action',
    {
      sha: '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
      comment: 'v7.3.0',
    },
  ],
  [
    'sigstore/cosign-installer',
    {
      sha: '6f9f17788090df1f26f669e9d70d6ae9567deba6',
      comment: 'v4.1.2',
    },
  ],
])

const EXPECTED_TARGETS: ExpectedTarget[] = [
  {
    key: 'darwin-arm64',
    os: 'macos-26',
    platform: 'darwin',
    arch: 'arm64',
    rustTarget: 'aarch64-apple-darwin',
  },
  {
    key: 'darwin-x64',
    os: 'macos-26-intel',
    platform: 'darwin',
    arch: 'x64',
    rustTarget: 'x86_64-apple-darwin',
  },
  {
    key: 'linux-x64',
    os: 'ubuntu-22.04',
    platform: 'linux',
    arch: 'x64',
    rustTarget: 'x86_64-unknown-linux-musl',
  },
  {
    key: 'linux-arm64',
    os: 'ubuntu-22.04-arm',
    platform: 'linux',
    arch: 'arm64',
    rustTarget: 'aarch64-unknown-linux-musl',
  },
  {
    key: 'win32-x64',
    os: 'windows-2025',
    platform: 'win32',
    arch: 'x64',
    rustTarget: 'x86_64-pc-windows-msvc',
  },
]
const EXPECTED_APP_PATHS = new Map([
  ['darwin-arm64', 'release/mac-arm64/Motrix.app'],
  ['darwin-x64', 'release/mac/Motrix.app'],
  ['linux-arm64', 'release/linux-arm64-unpacked'],
  ['linux-x64', 'release/linux-unpacked'],
  ['win32-x64', 'release/win-unpacked'],
])

const ciSource = readFileSync(
  path.join(ROOT, '.github/workflows/ci.yml'),
  'utf8'
)
const releaseSource = readFileSync(
  path.join(ROOT, '.github/workflows/release.yml'),
  'utf8'
)
const cargoConfigSource = readFileSync(
  path.join(ROOT, '.cargo/config.toml'),
  'utf8'
)
const nativeHostCargoManifestSource = readFileSync(
  path.join(ROOT, 'packages/native-host/Cargo.toml'),
  'utf8'
)
const windowsDependencyVerifierSource = readFileSync(
  path.join(ROOT, 'scripts/verify-windows-native-host-dependencies.ps1'),
  'utf8'
)
const ciWorkflow = asRecord(parseYaml(ciSource), 'CI workflow')
const releaseWorkflow = asRecord(parseYaml(releaseSource), 'release workflow')
const engineLock = asRecord(
  JSON.parse(
    readFileSync(path.join(ROOT, 'scripts/engine.lock.json'), 'utf8')
  ) as unknown,
  'engine lock'
)
const nativeHostTargets = BUILD_TARGETS as Map<string, unknown>

describe('CI and release target matrix contract', () => {
  it.each([
    ['CI', ciWorkflow],
    ['release', releaseWorkflow],
  ] as const)(
    '%s matrix contains exactly the five supported targets',
    (_, workflow) => {
      const { entries } = targetMatrix(workflow)
      const actual = entries
        .map((entry) => {
          const platform = stringField(entry, 'platform')
          const arch = stringField(entry, 'arch')
          return {
            key: `${platform}-${arch}`,
            os: stringField(entry, 'os'),
            platform,
            arch,
            rustTarget: stringField(entry, 'rust_target'),
          }
        })
        .sort(compareTargets)

      expect(actual).toEqual([...EXPECTED_TARGETS].sort(compareTargets))
    }
  )

  it('only enables targets supplied by both aria2 and native-host', () => {
    const engineAssets = asRecord(engineLock.assets, 'engine lock assets')

    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      for (const entry of targetMatrix(workflow).entries) {
        const key = `${stringField(entry, 'platform')}-${stringField(
          entry,
          'arch'
        )}`
        expect(
          engineAssets,
          `${key} must have a locked aria2 asset`
        ).toHaveProperty(key)
        expect(
          nativeHostTargets.has(key),
          `${key} must have a native-host build target`
        ).toBe(true)
        const nativeTarget = asRecord(
          nativeHostTargets.get(key),
          `${key} native-host target`
        )
        expect(stringField(entry, 'rust_target')).toBe(
          stringField(nativeTarget, 'rustTarget')
        )
      }
    }
  })

  it.each([
    ['CI', ciWorkflow],
    ['release', releaseWorkflow],
  ] as const)(
    '%s stages and verifies every Electron target before artifacts leave the job',
    (label, workflow) => {
      const { entries, job } = targetMatrix(workflow)
      const steps = jobSteps(job)
      const buildIndex = steps.findIndex((step) =>
        stringField(step, 'run', '').includes('build:electron')
      )
      const stageIndex = steps.findIndex((step) =>
        stringField(step, 'run', '').includes('stage:electron')
      )
      const builderIndices = steps
        .map((step, index) =>
          stringField(step, 'run', '').includes('electron-builder') ? index : -1
        )
        .filter((index) => index >= 0)
      const verifierIndex = steps.findIndex((step) =>
        stringField(step, 'run', '').includes('verify-electron-package.mjs')
      )
      const resourceIndex = steps.findIndex(
        (step) => step.name === 'Verify packaged resources'
      )

      expect(buildIndex).toBeGreaterThanOrEqual(0)
      expect(stageIndex).toBeGreaterThanOrEqual(buildIndex)
      expect(builderIndices.length).toBeGreaterThan(0)
      for (const builderIndex of builderIndices) {
        expect(builderIndex).toBeGreaterThan(stageIndex)
        expect(
          stringField(steps[builderIndex] as LooseRecord, 'run')
        ).toContain('--publish never')
      }
      expect(verifierIndex).toBeGreaterThan(Math.max(...builderIndices))
      expect(resourceIndex).toBeGreaterThan(verifierIndex)

      const buildCommand = stringField(steps[buildIndex] as LooseRecord, 'run')
      const stageCommand = stringField(steps[stageIndex] as LooseRecord, 'run')
      expect(stageCommand).toContain(`\${{ matrix.platform }}`)
      expect(stageCommand).toContain(`\${{ matrix.arch }}`)
      if (buildIndex === stageIndex) {
        expect(stageCommand.indexOf('stage:electron')).toBeGreaterThan(
          buildCommand.indexOf('build:electron')
        )
      }

      const verifier = stringField(steps[verifierIndex] as LooseRecord, 'run')
      expect(verifier).toContain(`--app-dir "\${{ matrix.app_path }}"`)
      expect(verifier).toContain(`--platform \${{ matrix.platform }}`)
      expect(verifier).toContain(`--arch \${{ matrix.arch }}`)
      expect(verifier).toContain(
        `--report "release/size-reports/\${{ matrix.target }}.json"`
      )

      for (const entry of entries) {
        const key = `${stringField(entry, 'platform')}-${stringField(
          entry,
          'arch'
        )}`
        expect(stringField(entry, 'app_path'), `${label} ${key}`).toBe(
          EXPECTED_APP_PATHS.get(key)
        )
      }

      const upload = steps.find((step) =>
        label === 'CI'
          ? step.name === 'Upload Electron size report'
          : step.name === 'Upload target release input'
      )
      const uploadInputs = asRecord(upload?.with, `${label} report upload`)
      expect(stringField(uploadInputs, 'path')).toContain(
        `release/size-reports/\${{ matrix.target }}.json`
      )
      expect(stringField(uploadInputs, 'if-no-files-found')).toBe('error')
      expect(steps.indexOf(upload as LooseRecord)).toBeGreaterThan(
        verifierIndex
      )
    }
  )

  it('keeps the release assembler on the same target set', () => {
    expect(
      RELEASE_TARGETS.map((target: { name: string }) => target.name).sort()
    ).toEqual(EXPECTED_TARGETS.map((target) => target.key).sort())
  })

  it('rejects versions that collide with the macOS updater architecture marker', () => {
    const unsafeVersion = '2.0.0-arm64.1'
    const macX64 = RELEASE_TARGETS.find(
      (target: { name: string }) => target.name === 'darwin-x64'
    ) as {
      assetNames(version: string): string[]
    }

    expect(macX64.assetNames(unsafeVersion)).toContain(
      'Motrix-2.0.0-arm64.1-x64.zip'
    )
    expect(
      macX64.assetNames(unsafeVersion).some((name) => name.includes('arm64'))
    ).toBe(true)
    expect(() =>
      resolveReleaseMetadata({
        eventName: 'workflow_dispatch',
        refName: 'main',
        refProtected: 'false',
        packageVersion: unsafeVersion,
      })
    ).toThrow(/lowercase "arm64".*ambiguous/)
  })

  it('statically links the Windows MSVC runtime and verifies PE imports', () => {
    expect(cargoConfigSource).toContain(
      `[target.'cfg(all(windows, target_env = "msvc"))']`
    )
    expect(cargoConfigSource).toContain('target-feature=+crt-static')

    for (const key of ['win32-x64', 'win32-arm64']) {
      const target = asRecord(
        nativeHostTargets.get(key),
        `${key} native-host target`
      )
      expect(stringField(target, 'rustTarget')).toMatch(/-pc-windows-msvc$/)
    }

    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const steps = jobSteps(targetMatrix(workflow).job)
      const verificationIndex = steps.findIndex(
        (step) => step.name === 'Verify Windows native host runtime imports'
      )
      const verification = steps[verificationIndex]
      expect(verification).toBeDefined()
      expect(stringField(verification as LooseRecord, 'if')).toContain(
        "matrix.platform == 'win32'"
      )
      const command = stringField(verification as LooseRecord, 'run')
      expect(command).toContain(
        'scripts/verify-windows-native-host-dependencies.ps1'
      )
      expect(command).toContain(`${'$'}{{ matrix.resources_dir }}`)
      expect(command).toContain('bin/motrix-native-host.exe')

      const windowsPackagingIndex = steps.findIndex((step) => {
        const command = stringField(step, 'run', '')
        const condition = stringField(step, 'if', '')
        return (
          command.includes('electron-builder') &&
          (condition === '' || condition.includes('win32'))
        )
      })
      expect(windowsPackagingIndex).toBeGreaterThanOrEqual(0)
      expect(verificationIndex).toBeGreaterThan(windowsPackagingIndex)
    }

    expect(windowsDependencyVerifierSource).toContain('/DEPENDENTS')
    for (const runtime of [
      'VCRUNTIME',
      'MSVCP',
      'CONCRT',
      'UCRTBASE',
      'api-ms-win-crt-',
    ]) {
      expect(windowsDependencyVerifierSource).toContain(runtime)
    }
  })
})

describe('general CI native-host split contract', () => {
  it('blocks on the shared allowlist and JavaScript packaging tests', () => {
    const jobs = workflowJobs(ciWorkflow)
    const ciJob = asRecord(jobs.ci, 'CI job')
    const steps = jobSteps(ciJob)
    const lint = steps.find((step) => step.name === 'Lint')
    const tooling = steps.find(
      (step) => step.name === 'Native host JavaScript tooling tests'
    )
    const contracts = steps.find(
      (step) => step.name === 'Release and packaging contracts'
    )

    expect(lint).toBeDefined()
    const lintCommand = stringField(lint as LooseRecord, 'run')
    expect(lintCommand).toContain(
      'packages/native-host/package-flatpak-companion.mjs'
    )
    expect(lintCommand).toContain(
      'packages/native-host/package-flatpak-companion.test.mjs'
    )
    expect(lintCommand).toContain('src/')

    expect(tooling).toBeDefined()
    const toolingCommand = stringField(tooling as LooseRecord, 'run')
    expect(toolingCommand).toContain('packages/native-host/build.test.mjs')
    expect(toolingCommand).toContain(
      'packages/native-host/package-flatpak-companion.test.mjs'
    )

    expect(contracts).toBeDefined()
    const contractCommand = stringField(contracts as LooseRecord, 'run')
    expect(contractCommand).toContain(
      'src/main/bridge/native-messaging-extensions.test.ts'
    )
    expect(contractCommand).toContain(
      'tests/scripts/flatpak-native-host.test.ts'
    )
    for (const test of [
      'tests/scripts/electron-package-contract.test.ts',
      'tests/scripts/native-binary-target.test.ts',
      'tests/scripts/stage-electron-app.test.ts',
      'tests/scripts/verify-electron-package.test.ts',
    ]) {
      expect(contractCommand).toContain(test)
    }
  })

  it('compiles every declared native-host binary on host and target runners', () => {
    for (const binary of [
      'motrix-native-host',
      'motrix-flatpak-native-host',
      'motrix-native-host-broker',
    ]) {
      expect(nativeHostCargoManifestSource).toContain(`name = "${binary}"`)
    }

    const jobs = workflowJobs(ciWorkflow)
    const rustQuality = asRecord(jobs['rust-quality'], 'rust-quality job')
    const rustTests = jobSteps(rustQuality).find(
      (step) => step.name === 'Tests'
    )
    expect(stringField(rustTests as LooseRecord, 'run')).toContain(
      '--all-targets'
    )

    const targetTests = jobSteps(targetMatrix(ciWorkflow).job).find(
      (step) => step.name === 'Tests (native target)'
    )
    expect(stringField(targetTests as LooseRecord, 'run')).toContain(
      '--all-targets'
    )
  })

  it('smoke-packages companions only on Linux', () => {
    const smoke = jobSteps(targetMatrix(ciWorkflow).job).find(
      (step) => step.name === 'Package Flatpak native host companion smoke'
    )

    expect(smoke).toBeDefined()
    expect(stringField(smoke as LooseRecord, 'if')).toContain(
      "matrix.platform == 'linux'"
    )
    const command = stringField(smoke as LooseRecord, 'run')
    expect(command).toContain('package:flatpak-native-host')
    expect(command).toContain('--arch "$COMPANION_ARCH"')
    expect(command).toContain('--output-dir "$COMPANION_OUTPUT"')
    expect(command).toContain('tar -tzf "$archive"')
  })

  it('keeps Flatpak-only binaries out of every ordinary Electron package', () => {
    const steps = jobSteps(targetMatrix(ciWorkflow).job)
    const packagingIndex = steps.findIndex((step) =>
      stringField(step, 'run', '').includes('electron-builder')
    )
    const verificationIndex = steps.findIndex(
      (step) => step.name === 'Verify packaged resources'
    )
    expect(packagingIndex).toBeGreaterThanOrEqual(0)
    expect(verificationIndex).toBeGreaterThan(packagingIndex)

    const command = stringField(steps[verificationIndex] as LooseRecord, 'run')
    expect(command).toContain("path.join('bin', host)")
    expect(command).toMatch(/path\.join\(\s*'extra'/)
    expect(command).toContain('motrix-flatpak-native-host')
    expect(command).toContain('motrix-native-host-broker')
    expect(command).toContain('Flatpak-only native host leaked into package')
  })
})

describe('release workflow publication contract', () => {
  it('gates every build and publication on validated release metadata', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const preflightJob = asRecord(jobs.preflight, 'preflight job')
    const preflightOutputs = asRecord(
      preflightJob.outputs,
      'preflight job outputs'
    )
    const preflightSteps = jobSteps(preflightJob)
    const metadataStep = preflightSteps.find((step) => step.id === 'metadata')
    const containerMetadataStep = preflightSteps.find(
      (step) => step.id === 'container'
    )
    const ancestryStep = preflightSteps.find((step) =>
      stringField(step, 'run', '').includes('git merge-base --is-ancestor')
    )

    expect(metadataStep).toBeDefined()
    const metadataEnvironment = asRecord(
      metadataStep?.env,
      'release metadata environment'
    )
    expect(stringField(metadataEnvironment, 'RELEASE_REF_PROTECTED')).toContain(
      'github.ref_protected'
    )
    expect(stringField(metadataStep as LooseRecord, 'run')).toContain(
      'scripts/release-metadata.mjs'
    )
    expect(stringField(preflightOutputs, 'version')).toContain(
      'steps.metadata.outputs.version'
    )
    expect(stringField(preflightOutputs, 'prerelease')).toContain(
      'steps.metadata.outputs.prerelease'
    )
    expect(stringField(preflightOutputs, 'channel')).toContain(
      'steps.metadata.outputs.channel'
    )
    expect(containerMetadataStep).toBeDefined()
    expect(stringField(containerMetadataStep as LooseRecord, 'run')).toContain(
      'scripts/container-release-metadata.mjs'
    )
    for (const output of [
      'container_version',
      'container_prerelease',
      'container_dockerhub_repository',
      'container_ghcr_repository',
      'container_immutable_tags',
      'container_floating_tags',
      'container_labels',
    ]) {
      expect(stringField(preflightOutputs, output)).toContain(
        `steps.container.outputs.${output}`
      )
    }
    expect(ancestryStep).toBeDefined()
    expect(stringField(ancestryStep as LooseRecord, 'if')).toContain(
      "github.event_name == 'push'"
    )
    expect(stringField(ancestryStep as LooseRecord, 'run')).toContain(
      'refs/remotes/origin/main'
    )

    expect(jobNeeds(asRecord(jobs.build, 'build job'))).toContain('preflight')
    expect(jobNeeds(asRecord(jobs.assemble, 'assemble job'))).toEqual(
      expect.arrayContaining(['preflight', 'build'])
    )
    expect(jobNeeds(asRecord(jobs.publish, 'publish job'))).toEqual(
      expect.arrayContaining(['preflight', 'assemble'])
    )
    expect(
      jobNeeds(asRecord(jobs['publish-feed'], 'publish-feed job'))
    ).toEqual(expect.arrayContaining(['preflight', 'assemble', 'publish']))
  })

  it('publishes once, from the publish job, and never on manual dispatch', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const releaseSteps = allSteps(releaseWorkflow).filter(({ step }) =>
      stringField(step, 'uses', '').startsWith('softprops/action-gh-release@')
    )

    expect(releaseSteps).toHaveLength(1)
    expect(releaseSteps[0]?.jobName).toBe('publish')

    const triggers = asRecord(releaseWorkflow.on, 'release workflow triggers')
    expect(triggers).toHaveProperty('workflow_dispatch')

    const publishJob = asRecord(jobs.publish, 'publish job')
    const publishCondition = stringField(publishJob, 'if')
    expect(publishCondition).toMatch(/github\.event_name\s*==\s*['"]push['"]/)
    expect(publishCondition).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(stringField(publishJob, 'environment')).toBe('github-release')

    const publishStep = releaseSteps[0]?.step
    const publishInputs = asRecord(
      publishStep?.with,
      'GitHub Release action inputs'
    )
    expect(stringField(publishInputs, 'prerelease')).toContain(
      'needs.preflight.outputs.prerelease'
    )
  })

  it('publishes resumable signed multi-architecture containers only from release tags', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const containerJob = asRecord(
      jobs['publish-container'],
      'publish-container job'
    )
    expect(jobNeeds(containerJob)).toEqual(
      expect.arrayContaining(['preflight', 'publish'])
    )
    const condition = stringField(containerJob, 'if')
    expect(condition).toContain("github.event_name == 'push'")
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(stringField(containerJob, 'environment')).toBe('container-release')
    expect(asRecord(containerJob.permissions, 'container permissions')).toEqual(
      {
        contents: 'read',
        'id-token': 'write',
        packages: 'write',
      }
    )

    const steps = jobSteps(containerJob)
    const stepIndex = (name: string) =>
      steps.findIndex((step) => step.name === name)
    const build =
      steps[stepIndex('Build and stage immutable multi-architecture image')]
    expect(build).toBeDefined()
    const buildInputs = asRecord(build?.with, 'container build inputs')
    expect(stringField(buildInputs, 'platforms')).toBe(
      'linux/amd64,linux/arm64'
    )
    expect(buildInputs.push).toBe(true)
    expect(buildInputs.sbom).toBe(true)
    expect(stringField(buildInputs, 'provenance')).toBe('mode=max')
    expect(stringField(buildInputs, 'cache-from')).toContain('type=gha')
    expect(stringField(buildInputs, 'cache-to')).toContain('mode=max')

    const qemu = steps.find((step) => step.name === 'Set up pinned QEMU')
    expect(stringField(asRecord(qemu?.with, 'QEMU inputs'), 'image')).toMatch(
      /^tonistiigi\/binfmt@sha256:[0-9a-f]{64}$/
    )
    expect(stringField(asRecord(qemu?.with, 'QEMU inputs'), 'platforms')).toBe(
      'arm64'
    )

    const inspectCommand = stringField(
      steps[stepIndex('Inspect existing immutable tags')] as LooseRecord,
      'run'
    )
    expect(inspectCommand).not.toContain('pull access denied')
    expect(stepIndex('Resolve immutable publication state')).toBeLessThan(
      stepIndex('Build and stage immutable multi-architecture image')
    )
    expect(stepIndex('Verify immutable publication state')).toBeLessThan(
      stepIndex('Sign immutable digests with GitHub OIDC')
    )
    expect(stepIndex('Sign immutable digests with GitHub OIDC')).toBeLessThan(
      stepIndex('Prepare anonymous registry client')
    )
    expect(stepIndex('Verify immutable signatures')).toBeLessThan(
      stepIndex('Verify anonymous multi-architecture artifacts')
    )
    expect(
      stepIndex('Verify anonymous multi-architecture artifacts')
    ).toBeLessThan(stepIndex('Smoke anonymous published architectures'))
    expect(stepIndex('Smoke anonymous published architectures')).toBeLessThan(
      stepIndex('Promote stable container aliases')
    )
    expect(stepIndex('Promote stable container aliases')).toBeLessThan(
      stepIndex('Update Docker Hub description')
    )

    const publicVerification = steps[
      stepIndex('Verify anonymous multi-architecture artifacts')
    ] as LooseRecord
    expect(
      stringField(
        asRecord(publicVerification.env, 'anonymous env'),
        'DOCKER_CONFIG'
      )
    ).toContain('anonymous-docker')
    const publicCommand = stringField(publicVerification, 'run')
    expect(publicCommand).toContain("--format '{{json .SBOM}}'")
    expect(publicCommand).toContain("--format '{{json .Provenance}}'")
    expect(publicCommand).toContain('verify-container-publication.mjs')
    const smokeCommand = stringField(
      steps[
        stepIndex('Smoke anonymous published architectures')
      ] as LooseRecord,
      'run'
    )
    expect(smokeCommand).toContain('--platform linux/amd64')
    expect(smokeCommand).toContain('--platform linux/arm64')
    expect(smokeCommand).toContain('--mode health')
    expect(smokeCommand).toContain('smoke-server-image.mjs')

    const allOtherJobs = Object.entries(jobs).filter(
      ([name]) => name !== 'publish-container'
    )
    expect(JSON.stringify(allOtherJobs)).not.toContain('DOCKERHUB_TOKEN')
    expect(JSON.stringify(allOtherJobs)).not.toContain('packages":"write')
  })

  it('assembles all target artifacts before publication', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const assembleJob = asRecord(jobs.assemble, 'assemble job')
    const assembleCommands = jobSteps(assembleJob).map((step) =>
      stringField(step, 'run', '')
    )

    expect(
      assembleCommands.some((command) =>
        command.includes('scripts/assemble-release-artifacts.mjs')
      )
    ).toBe(true)
  })

  it('publishes the generic feed only after GitHub and writes manifests last', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const feedJob = asRecord(jobs['publish-feed'], 'publish-feed job')
    expect(stringField(feedJob, 'environment')).toBe('app-update-feed')
    expect(stringField(feedJob, 'if')).toContain(
      "startsWith(github.ref, 'refs/tags/v')"
    )

    const environment = asRecord(feedJob.env, 'publish-feed environment')
    for (const [name, secret] of [
      ['AWS_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
      ['AWS_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
      ['R2_ACCOUNT_ID', 'R2_ACCOUNT_ID'],
      ['R2_BUCKET', 'R2_BUCKET'],
    ] as const) {
      expect(stringField(environment, name)).toContain(`secrets.${secret}`)
    }

    const steps = jobSteps(feedJob)
    const assetsIndex = steps.findIndex(
      (step) => step.name === 'Upload versioned update assets'
    )
    const manifestsIndex = steps.findIndex(
      (step) => step.name === 'Publish channel manifests'
    )
    expect(assetsIndex).toBeGreaterThanOrEqual(0)
    expect(manifestsIndex).toBeGreaterThan(assetsIndex)

    const assetsCommand = stringField(steps[assetsIndex] as LooseRecord, 'run')
    expect(assetsCommand).toContain("--exclude '*.yml'")
    expect(assetsCommand).toContain('/releases/')
    const manifestsCommand = stringField(
      steps[manifestsIndex] as LooseRecord,
      'run'
    )
    expect(manifestsCommand).toContain("--include 'latest*.yml'")
    expect(manifestsCommand).toContain("--include 'beta*.yml'")
    expect(manifestsCommand).toContain("--exclude '*'")
    expect(manifestsCommand).toContain('no-cache')
  })

  it('uploads only stable and beta metadata from target builds', () => {
    const upload = jobSteps(targetMatrix(releaseWorkflow).job).find(
      (step) => step.name === 'Upload target release input'
    )
    const paths = stringField(
      asRecord(upload?.with, 'release input upload'),
      'path'
    )

    expect(paths).toContain('release/latest*.yml')
    expect(paths).toContain('release/beta*.yml')
    expect(paths).not.toContain('release/*.yml')
    expect(paths).not.toContain('alpha')
  })

  it('builds only deb and rpm Linux release assets', () => {
    const linuxTargets = targetMatrix(releaseWorkflow).entries.filter(
      (entry) => entry.platform === 'linux'
    )

    expect(linuxTargets).toHaveLength(2)
    for (const entry of linuxTargets) {
      const args = stringField(entry, 'electron_builder_args')
      expect(args).toMatch(/\bdeb\b/)
      expect(args).toMatch(/\brpm\b/)
      expect(args).not.toMatch(/\bAppImage\b/)
      expect(args).not.toMatch(/\bsnap\b/i)
    }
    expect(releaseSource).toContain(`\${{ matrix.electron_builder_args }}`)
    expect(releaseSource).not.toContain('release/*.AppImage')

    const buildJob = targetMatrix(releaseWorkflow).job
    const linuxVerification = jobSteps(buildJob).find(
      (step) => step.name === 'Verify Linux package formats'
    )
    expect(linuxVerification).toBeDefined()
    const verificationCommand = stringField(
      linuxVerification as LooseRecord,
      'run'
    )
    expect(verificationCommand).toContain('release/*.deb')
    expect(verificationCommand).toContain('release/*.rpm')
    expect(verificationCommand).not.toContain('AppImage')
  })

  it('publishes required Flatpak companions outside updater manifests', () => {
    const buildJob = targetMatrix(releaseWorkflow).job
    const steps = jobSteps(buildJob)
    const packaging = steps.find(
      (step) => step.name === 'Package Flatpak native host companion'
    )
    const verification = steps.find(
      (step) => step.name === 'Verify Flatpak native host companion archive'
    )
    const upload = steps.find(
      (step) => step.name === 'Upload target release input'
    )

    expect(packaging).toBeDefined()
    expect(stringField(packaging as LooseRecord, 'if')).toContain(
      "matrix.platform == 'linux'"
    )
    const packagingCommand = stringField(packaging as LooseRecord, 'run')
    expect(packagingCommand).toContain('package:flatpak-native-host')
    expect(packagingCommand).toContain('--version "$COMPANION_VERSION"')
    expect(packagingCommand).toContain('--arch "$COMPANION_ARCH"')
    expect(packagingCommand).toContain('--output-dir release')

    expect(verification).toBeDefined()
    expect(stringField(verification as LooseRecord, 'if')).toContain(
      "matrix.platform == 'linux'"
    )
    const verificationCommand = stringField(verification as LooseRecord, 'run')
    expect(verificationCommand).toContain('tar -tzf "$archive"')
    expect(verificationCommand).toContain('motrix-flatpak-native-host')
    expect(verificationCommand).toContain('README.zh-CN.md')

    const uploadInputs = asRecord(upload?.with, 'release input upload')
    expect(stringField(uploadInputs, 'path')).toContain('release/*.tar.gz')

    for (const [targetName, arch] of [
      ['linux-x64', 'x64'],
      ['linux-arm64', 'arm64'],
    ] as const) {
      const target = RELEASE_TARGETS.find(
        (candidate: { name: string }) => candidate.name === targetName
      ) as {
        assetNames(version: string): string[]
        manifestAssetNames(version: string): string[]
      }
      const companion = `Motrix-Native-Host-2.0.0-linux-${arch}.tar.gz`
      expect(target.assetNames('2.0.0')).toContain(companion)
      expect(target.manifestAssetNames('2.0.0')).not.toContain(companion)
    }
  })

  it('isolates signing credentials behind platform-specific environments', () => {
    const { job } = targetMatrix(releaseWorkflow)
    const environment = asRecord(job.environment, 'build environment')
    const environmentName = stringField(environment, 'name')
    expect(environmentName).toContain("matrix.platform == 'darwin'")
    expect(environmentName).toContain('macos-release-signing')
    expect(environmentName).toContain("matrix.platform == 'win32'")
    expect(environmentName).toContain('windows-release-signing')
    expect(environmentName).toContain('release-build')
    expect(environmentName).toContain("github.event_name == 'push'")
    expect(environment.deployment).toBe(false)

    const builderSteps = jobSteps(job).filter((step) =>
      stringField(step, 'run', '').includes('electron-builder')
    )

    const macStep = platformBuilderStep(builderSteps, 'darwin')
    const windowsStep = platformBuilderStep(builderSteps, 'win32')
    const linuxStep = platformBuilderStep(builderSteps, 'linux')
    const macEnv = asRecord(macStep.env, 'macOS builder environment')
    const windowsEnv = asRecord(windowsStep.env, 'Windows builder environment')
    const linuxEnv = optionalRecord(linuxStep.env)

    expect(stringField(macEnv, 'CSC_LINK')).toContain('secrets.MAC_CERTS')
    expect(stringField(macEnv, 'CSC_KEY_PASSWORD')).toContain(
      'secrets.MAC_CERTS_PASSWORD'
    )
    expect(JSON.stringify(macEnv)).not.toContain('WIN_CSC')

    expect(stringField(windowsEnv, 'CSC_LINK')).toContain(
      'secrets.WIN_CSC_LINK'
    )
    expect(stringField(windowsEnv, 'CSC_KEY_PASSWORD')).toContain(
      'secrets.WIN_CSC_KEY_PASSWORD'
    )
    expect(JSON.stringify(windowsEnv)).not.toContain('MAC_CERTS')

    expect(linuxEnv).not.toHaveProperty('CSC_LINK')
    expect(linuxEnv).not.toHaveProperty('CSC_KEY_PASSWORD')
    expect(JSON.stringify(linuxEnv)).not.toContain('secrets.')

    expect(releaseSource).toContain('APPLE_API_ISSUER')
    expect(releaseSource).not.toContain('secrets.TEAM_ID')
    expect(releaseSource).not.toContain('APPLE_TEAM_ID')
  })

  it('verifies notarization stapling in addition to macOS signatures', () => {
    const buildJob = targetMatrix(releaseWorkflow).job
    const verification = jobSteps(buildJob).find(
      (step) => step.name === 'Verify macOS signatures'
    )

    expect(verification).toBeDefined()
    const command = stringField(verification as LooseRecord, 'run')
    expect(command).toContain('codesign --verify')
    expect(command).toContain('xcrun stapler validate')
  })

  it('pins the packaged macOS baseline to Electron 43 support', () => {
    const builderConfig = asRecord(
      JSON.parse(
        readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8')
      ) as unknown,
      'electron-builder config'
    )
    const macConfig = asRecord(builderConfig.mac, 'electron-builder mac config')

    expect(stringField(macConfig, 'minimumSystemVersion')).toBe('12.0')
    expect(stringField(macConfig, 'artifactName')).toMatch(/\$\{arch\}/)
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const { job } = targetMatrix(workflow)
      const env = asRecord(job.env, 'target job environment')
      expect(stringField(env, 'MACOSX_DEPLOYMENT_TARGET')).toContain('12.0')
    }
  })
})

describe('workflow action supply-chain contract', () => {
  it('pins every external action to the reviewed full commit SHA', () => {
    const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
    expect(workflowFiles.length).toBeGreaterThan(0)

    for (const workflowFile of workflowFiles) {
      const source = readFileSync(
        path.join(WORKFLOW_DIRECTORY, workflowFile),
        'utf8'
      )
      for (const [index, line] of source.split('\n').entries()) {
        if (!/^\s*(?:-\s*)?uses:/.test(line)) continue
        const use = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/.exec(
          line
        )
        expect(
          use,
          `${workflowFile}:${index + 1} must keep uses, full SHA, and version comment on one line`
        ).not.toBeNull()

        const specifier = use?.[1] as string
        if (specifier.startsWith('./') || specifier.startsWith('docker://')) {
          continue
        }

        const separator = specifier.lastIndexOf('@')
        expect(
          separator,
          `${workflowFile}:${index + 1} must include an action ref`
        ).toBeGreaterThan(0)
        const action = specifier.slice(0, separator)
        const ref = specifier.slice(separator + 1)
        const expected = EXPECTED_ACTION_PINS.get(action)

        expect(
          expected,
          `${workflowFile}:${index + 1} uses an unreviewed action ${action}`
        ).toBeDefined()
        expect(
          ref,
          `${workflowFile}:${index + 1} must use the reviewed SHA`
        ).toBe(expected?.sha)
        expect(
          use?.[2],
          `${workflowFile}:${index + 1} must retain the human-readable version comment`
        ).toBe(expected?.comment)
      }
    }
  })

  it('pins pnpm v11 consistently across local and CI toolchains', () => {
    const packageMetadata = asRecord(
      JSON.parse(
        readFileSync(path.join(ROOT, 'package.json'), 'utf8')
      ) as unknown,
      'package metadata'
    )
    expect(stringField(packageMetadata, 'packageManager')).toBe(
      PNPM_PACKAGE_MANAGER
    )

    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain(`corepack prepare pnpm@${PNPM_VERSION}`)
    expect(dockerfile).not.toMatch(/pnpm@(?:latest|9(?:\D|$))/)

    let setupCount = 0
    for (const workflowFile of readdirSync(WORKFLOW_DIRECTORY)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()) {
      const workflow = asRecord(
        parseYaml(
          readFileSync(path.join(WORKFLOW_DIRECTORY, workflowFile), 'utf8')
        ),
        `${workflowFile} workflow`
      )
      for (const { step } of allSteps(workflow)) {
        if (!stringField(step, 'uses', '').startsWith('pnpm/action-setup@')) {
          continue
        }
        setupCount += 1
        const inputs = asRecord(step.with, `${workflowFile} pnpm setup inputs`)
        expect(
          String(inputs.version),
          `${workflowFile} must use the repository pnpm version`
        ).toBe(PNPM_VERSION)
      }
    }

    expect(setupCount).toBeGreaterThan(0)
  })
})

function asRecord(value: unknown, label: string): LooseRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as LooseRecord
}

function optionalRecord(value: unknown): LooseRecord {
  return value === undefined ? {} : asRecord(value, 'optional value')
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

function jobSteps(job: LooseRecord): LooseRecord[] {
  if (!Array.isArray(job.steps))
    throw new TypeError('job steps must be an array')
  return job.steps.map((step) => asRecord(step, 'workflow step'))
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

function allSteps(
  workflow: LooseRecord
): Array<{ jobName: string; step: LooseRecord }> {
  return Object.entries(workflowJobs(workflow)).flatMap(([jobName, value]) => {
    const job = asRecord(value, `${jobName} job`)
    if (!Array.isArray(job.steps)) return []
    return jobSteps(job).map((step) => ({ jobName, step }))
  })
}

function targetMatrix(workflow: LooseRecord): {
  jobName: string
  job: LooseRecord
  entries: LooseRecord[]
} {
  const candidates = Object.entries(workflowJobs(workflow)).flatMap(
    ([jobName, value]) => {
      const job = asRecord(value, `${jobName} job`)
      if (job.strategy === undefined) return []
      const strategy = asRecord(job.strategy, `${jobName} strategy`)
      if (strategy.matrix === undefined) return []
      const matrix = asRecord(strategy.matrix, `${jobName} matrix`)
      if (!Array.isArray(matrix.include)) return []
      const entries = matrix.include.map((entry) =>
        asRecord(entry, `${jobName} matrix entry`)
      )
      if (
        !entries.every(
          (entry) =>
            typeof entry.platform === 'string' && typeof entry.arch === 'string'
        )
      ) {
        return []
      }
      return [{ jobName, job, entries }]
    }
  )

  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one platform/arch matrix, found ${candidates.length}`
    )
  }
  return candidates[0] as (typeof candidates)[number]
}

function platformBuilderStep(
  steps: LooseRecord[],
  platform: string
): LooseRecord {
  const matches = steps.filter((step) => {
    const condition = stringField(step, 'if', '')
    return condition.includes('matrix.platform') && condition.includes(platform)
  })
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one electron-builder step for ${platform}, found ${matches.length}`
    )
  }
  return matches[0] as LooseRecord
}

function compareTargets(left: ExpectedTarget, right: ExpectedTarget): number {
  return left.key.localeCompare(right.key)
}
