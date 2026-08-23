import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript build script intentionally has no declarations
import { BUILD_TARGETS } from '../../packages/native-host/build.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { RELEASE_TARGETS } from '../../scripts/assemble-release-artifacts.mjs'
// @ts-expect-error -- JavaScript build hook intentionally has no declarations
import stagedDependenciesBoundary from '../../scripts/before-build-use-staged-dependencies.mjs'
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
const PNPM_VERSION = '11.22.0'
const PNPM_PACKAGE_MANAGER =
  'pnpm@11.22.0+sha512.1ff870c4c6133dfd88fb2afc46dd13d47f09c9794b438c6fdb47ca98caf3bc16381ee0be93a091b8e3824cf01f889f46d7d9e20910fb0be1ab0fb5baa80dd621'
const ELECTRON_BUILDER_CUSTOM_DIR_ENVIRONMENT_VARIABLES = [
  'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
  'npm_config_electron_builder_binaries_custom_dir',
  'npm_package_config_electron_builder_binaries_custom_dir',
  'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
] as const
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
const signingConfigSource = readFileSync(
  path.join(ROOT, 'electron-builder.signing.json'),
  'utf8'
)
const signingInputSource = readFileSync(
  path.join(ROOT, 'scripts/release-signing-input.mjs'),
  'utf8'
)
const stagedDependenciesHookSource = readFileSync(
  path.join(ROOT, 'scripts/before-build-use-staged-dependencies.mjs'),
  'utf8'
)
const signingToolPackageSource = readFileSync(
  path.join(ROOT, 'scripts/release-signing-tool/package.json'),
  'utf8'
)
const signingToolLockSource = readFileSync(
  path.join(ROOT, 'scripts/release-signing-tool/package-lock.json'),
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

  it('hydrates the Electron runtime after install and before the release notice gate', () => {
    const steps = jobSteps(targetMatrix(releaseWorkflow).job)
    const dependencyIndex = steps.findIndex(
      (step) => step.name === 'Install dependencies'
    )
    const electronIndex = steps.findIndex(
      (step) => step.name === 'Ensure Electron runtime payload'
    )
    const noticeIndex = steps.findIndex(
      (step) => step.name === 'Third-party notice contract'
    )

    expect(dependencyIndex).toBeGreaterThanOrEqual(0)
    expect(electronIndex).toBeGreaterThan(dependencyIndex)
    expect(noticeIndex).toBeGreaterThan(electronIndex)
    expect(stringField(steps[electronIndex] as LooseRecord, 'run')).toBe(
      'node node_modules/electron/install.js'
    )
    expect(stringField(steps[noticeIndex] as LooseRecord, 'run')).toBe(
      'pnpm run check:third-party-notices'
    )
  })

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

    // Lint runs through the package script so the workflow, the local
    // commit gate, and biome.json cannot drift apart. The repo-wide
    // `biome check .` keeps the native-host tooling scripts covered —
    // the guarantee the previous explicit path list existed for.
    expect(lint).toBeDefined()
    const lintCommand = stringField(lint as LooseRecord, 'run')
    expect(lintCommand.trim()).toBe('pnpm run lint')
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    expect(packageJson.scripts?.lint).toBe('biome check .')

    const fingerprint = steps.find(
      (step) => step.name === 'Biome toolchain fingerprint'
    )
    expect(fingerprint).toBeDefined()
    expect(stringField(fingerprint as LooseRecord, 'run')).toContain(
      'biome --version'
    )

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
      'tests/scripts/appimage-artifact.test.ts',
      'tests/scripts/electron-package-contract.test.ts',
      'tests/scripts/finalize-appimage-artifact.test.ts',
      'tests/scripts/native-binary-target.test.ts',
      'tests/scripts/release-signing-input.test.ts',
      'tests/scripts/stage-electron-app.test.ts',
      'tests/scripts/verify-electron-package.test.ts',
      'tests/scripts/verify-appimage-artifact.test.ts',
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
  it('derives the GitHub Release body from validated version metadata', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const preflightJob = asRecord(jobs.preflight, 'preflight job')
    const preflightOutputs = asRecord(
      preflightJob.outputs,
      'preflight job outputs'
    )
    const preflightSteps = jobSteps(preflightJob)
    const metadataIndex = preflightSteps.findIndex(
      (step) => step.id === 'metadata'
    )
    const releaseNotesIndex = preflightSteps.findIndex(
      (step) => step.id === 'release_notes'
    )

    expect(metadataIndex).toBeGreaterThanOrEqual(0)
    expect(releaseNotesIndex).toBeGreaterThan(metadataIndex)
    expect(stringField(preflightOutputs, 'release_notes_path')).toBe(
      `\${{ steps.release_notes.outputs.path }}`
    )

    const releaseNotesStep = preflightSteps[releaseNotesIndex] as LooseRecord
    const releaseNotesEnvironment = asRecord(
      releaseNotesStep.env,
      'release notes environment'
    )
    expect(releaseNotesEnvironment).toEqual({
      RELEASE_VERSION: `\${{ steps.metadata.outputs.version }}`,
    })

    const releaseNotesCommand = stringField(releaseNotesStep, 'run')
    expect(releaseNotesCommand).toContain(
      '[[ ! "$RELEASE_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]'
    )
    expect(releaseNotesCommand).toContain(`[[ "$RELEASE_VERSION" == *'..'* ]]`)
    expect(releaseNotesCommand).toContain(
      `release_notes_path="docs/release-notes/\${RELEASE_VERSION}.md"`
    )
    expect(releaseNotesCommand).toContain('[[ ! -f "$release_notes_path" ]]')
    expect(releaseNotesCommand).toContain(
      `printf 'path=%s\\n' "$release_notes_path" >> "$GITHUB_OUTPUT"`
    )
    expect(releaseNotesCommand).not.toMatch(/github\.(?:ref|ref_name)/)

    const publishSteps = jobSteps(asRecord(jobs.publish, 'publish job'))
    const checkoutIndex = publishSteps.findIndex((step) =>
      stringField(step, 'uses', '').startsWith('actions/checkout@')
    )
    const releaseIndex = publishSteps.findIndex((step) =>
      stringField(step, 'uses', '').startsWith('softprops/action-gh-release@')
    )
    expect(checkoutIndex).toBeGreaterThanOrEqual(0)
    expect(releaseIndex).toBeGreaterThan(checkoutIndex)
    const checkoutInputs = asRecord(
      publishSteps[checkoutIndex]?.with,
      'publish checkout inputs'
    )
    expect(checkoutInputs['persist-credentials']).toBe(false)

    const publishInputs = asRecord(
      publishSteps[releaseIndex]?.with,
      'GitHub Release action inputs'
    )
    expect(stringField(publishInputs, 'body_path')).toBe(
      `\${{ needs.preflight.outputs.release_notes_path }}`
    )
    expect(publishInputs.generate_release_notes).toBe(true)
  })

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
    expect(asRecord(triggers.push, 'release push trigger')).toEqual({
      tags: ['v*'],
    })

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

  it('fans native container builds into one fail-closed signed index and promotes aliases last', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const plan = asRecord(
      jobs['plan-container-publication'],
      'container publication plan job'
    )
    const platformBuild = asRecord(
      jobs['build-container-platform'],
      'container platform build job'
    )
    const finalize = asRecord(
      jobs['publish-container'],
      'publish-container job'
    )
    const runtime = asRecord(
      jobs['verify-container-runtime'],
      'container runtime job'
    )
    const promote = asRecord(
      jobs['promote-container-aliases'],
      'container alias promotion job'
    )

    expect(jobNeeds(plan)).toEqual(
      expect.arrayContaining(['preflight', 'publish'])
    )
    expect(jobNeeds(platformBuild)).toEqual(
      expect.arrayContaining([
        'preflight',
        'publish',
        'plan-container-publication',
      ])
    )
    expect(jobNeeds(finalize)).toEqual(
      expect.arrayContaining([
        'preflight',
        'publish',
        'plan-container-publication',
        'build-container-platform',
      ])
    )
    expect(jobNeeds(runtime)).toEqual(
      expect.arrayContaining(['preflight', 'publish-container'])
    )
    expect(jobNeeds(promote)).toEqual(
      expect.arrayContaining([
        'preflight',
        'publish-container',
        'verify-container-runtime',
      ])
    )

    expect(stringField(platformBuild, 'if')).toContain(
      "needs.plan-container-publication.outputs.action == 'build'"
    )
    const finalCondition = stringField(finalize, 'if')
    expect(finalCondition).toContain('always()')
    expect(finalCondition).toContain(
      "needs.plan-container-publication.outputs.action == 'build'"
    )
    expect(finalCondition).toContain(
      "needs.build-container-platform.result == 'success'"
    )
    expect(finalCondition).toContain(
      "needs.build-container-platform.result == 'skipped'"
    )
    for (const job of [plan, finalize, runtime]) {
      const condition = stringField(job, 'if', finalCondition)
      expect(condition).toContain("github.event_name == 'push'")
      expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')")
    }

    const matrix = asRecord(
      asRecord(platformBuild.strategy, 'platform build strategy').matrix,
      'platform build matrix'
    )
    expect(matrix.include).toEqual([
      {
        platform: 'linux/amd64',
        os: 'ubuntu-22.04',
        runner_arch: 'X64',
        artifact: 'container-build-linux-amd64',
        metadata_file: 'linux-amd64.json',
      },
      {
        platform: 'linux/arm64',
        os: 'ubuntu-22.04-arm',
        runner_arch: 'ARM64',
        artifact: 'container-build-linux-arm64',
        metadata_file: 'linux-arm64.json',
      },
    ])
    expect(stringField(platformBuild, 'runs-on')).toBe(`\${{ matrix.os }}`)
    expect(stringField(platformBuild, 'environment')).toBe('container-release')
    expect(
      asRecord(platformBuild.permissions, 'platform build permissions')
    ).toEqual({
      contents: 'read',
      packages: 'write',
    })
    expect(asRecord(finalize.permissions, 'finalize permissions')).toEqual({
      contents: 'read',
      'id-token': 'write',
      packages: 'write',
    })
    expect(asRecord(runtime.permissions, 'runtime permissions')).toEqual({
      contents: 'read',
    })

    const buildSteps = jobSteps(platformBuild)
    const buildStepIndex = (name: string) =>
      buildSteps.findIndex((step) => step.name === name)
    const build =
      buildSteps[buildStepIndex('Build and push native platform digest')]
    const buildInputs = asRecord(build?.with, 'native container build inputs')
    expect(stringField(buildInputs, 'platforms')).toBe(
      `\${{ matrix.platform }}`
    )
    expect(stringField(buildInputs, 'outputs')).toContain('push-by-digest=true')
    expect(stringField(buildInputs, 'outputs')).toContain('name-canonical=true')
    expect(stringField(buildInputs, 'outputs')).toContain('oci-artifact=true')
    expect(stringField(buildInputs, 'outputs')).toContain('push=true')
    expect(buildInputs).not.toHaveProperty('tags')
    expect(buildInputs.sbom).toBe(true)
    expect(stringField(buildInputs, 'provenance')).toBe('mode=max')
    expect(stringField(buildInputs, 'cache-from')).toContain(
      'matrix.runner_arch'
    )
    expect(stringField(buildInputs, 'cache-to')).toContain('mode=max')
    expect(
      buildStepIndex('Require native GitHub-hosted Linux runner')
    ).toBeLessThan(buildStepIndex('Build and push native platform digest'))
    expect(buildStepIndex('Inspect staged platform digests')).toBeLessThan(
      buildStepIndex('Smoke anonymous staged platform digests')
    )
    expect(
      buildStepIndex('Smoke anonymous staged platform digests')
    ).toBeLessThan(buildStepIndex('Write immutable platform build metadata'))
    expect(
      buildStepIndex('Write immutable platform build metadata')
    ).toBeLessThan(buildStepIndex('Upload immutable platform build metadata'))
    const runnerCommand = stringField(
      buildSteps[
        buildStepIndex('Require native GitHub-hosted Linux runner')
      ] as LooseRecord,
      'run'
    )
    expect(runnerCommand).toContain("'github-hosted'")
    expect(runnerCommand).toContain('EXPECTED_RUNNER_ARCH')
    const stagedSmoke = stringField(
      buildSteps[
        buildStepIndex('Smoke anonymous staged platform digests')
      ] as LooseRecord,
      'run'
    )
    expect(stagedSmoke).toContain('smoke-server-image.mjs')
    expect(stagedSmoke).toContain('"$DOCKERHUB_REPOSITORY" "$GHCR_REPOSITORY"')
    expect(stagedSmoke).not.toContain('--mode health')
    const metadataCommand = stringField(
      buildSteps[
        buildStepIndex('Write immutable platform build metadata')
      ] as LooseRecord,
      'run'
    )
    expect(metadataCommand).toContain('container-platform-metadata.mjs create')
    expect(metadataCommand).toContain('--runner-arch')
    expect(metadataCommand).toContain('--docker-hub-index')
    expect(metadataCommand).toContain('--ghcr-index')
    const metadataUpload = buildSteps[
      buildStepIndex('Upload immutable platform build metadata')
    ] as LooseRecord
    expect(
      asRecord(metadataUpload.with, 'metadata upload inputs').overwrite
    ).toBe(true)

    const finalSteps = jobSteps(finalize)
    const finalStepIndex = (name: string) =>
      finalSteps.findIndex((step) => step.name === name)
    const metadataDownloads = finalSteps
      .filter((step) =>
        stringField(step, 'uses', '').startsWith('actions/download-artifact@')
      )
      .map((step) =>
        stringField(asRecord(step.with, 'metadata download inputs'), 'name')
      )
    expect(metadataDownloads).toEqual([
      'container-build-linux-amd64',
      'container-build-linux-arm64',
    ])
    for (const step of finalSteps.filter((step) =>
      stringField(step, 'uses', '').startsWith('actions/download-artifact@')
    )) {
      expect(step.if).toBeUndefined()
    }
    expect(finalStepIndex('Verify complete platform build set')).toBeLessThan(
      finalStepIndex('Revalidate immutable tags before finalization')
    )
    expect(finalStepIndex('Resolve finalization state')).toBeLessThan(
      finalStepIndex('Create immutable multi-platform indexes')
    )
    expect(
      finalStepIndex('Create immutable multi-platform indexes')
    ).toBeLessThan(finalStepIndex('Verify immutable publication state'))
    expect(
      finalStepIndex('Verify partial immutable source before repair')
    ).toBeLessThan(finalStepIndex('Repair partial immutable publication'))
    expect(finalStepIndex('Repair partial immutable publication')).toBeLessThan(
      finalStepIndex('Verify immutable publication state')
    )
    expect(finalStepIndex('Verify immutable publication state')).toBeLessThan(
      finalStepIndex(
        'Verify anonymous multi-platform index artifacts before signing'
      )
    )
    expect(
      finalStepIndex(
        'Verify anonymous multi-platform index artifacts before signing'
      )
    ).toBeLessThan(finalStepIndex('Sign immutable digests with GitHub OIDC'))
    expect(
      finalStepIndex('Sign immutable digests with GitHub OIDC')
    ).toBeLessThan(finalStepIndex('Verify immutable signatures'))
    const setCommand = stringField(
      finalSteps[
        finalStepIndex('Verify complete platform build set')
      ] as LooseRecord,
      'run'
    )
    expect(setCommand).toContain('container-platform-metadata.mjs verify-set')
    expect(setCommand).toContain('--builder-attempt "$GITHUB_RUN_ATTEMPT"')
    const createCommand = stringField(
      finalSteps[
        finalStepIndex('Create immutable multi-platform indexes')
      ] as LooseRecord,
      'run'
    )
    expect(createCommand).toContain('AMD64_DIGEST')
    expect(createCommand).toContain('ARM64_DIGEST')
    expect(createCommand).toContain('imagetools create')
    const repairVerification = stringField(
      finalSteps[
        finalStepIndex('Verify partial immutable source before repair')
      ] as LooseRecord,
      'run'
    )
    expect(repairVerification).toContain('--repository "$source_repository"')
    expect(repairVerification).toContain(
      '--platform-metadata "$VERIFIED_METADATA"'
    )
    expect(repairVerification).toContain("--format '{{json .SBOM}}'")
    expect(repairVerification).toContain("--format '{{json .Provenance}}'")

    const signatureVerification = finalSteps[
      finalStepIndex('Verify immutable signatures')
    ] as LooseRecord
    const signatureEnvironment = asRecord(
      signatureVerification.env,
      'signature verification environment'
    )
    expect(stringField(signatureEnvironment, 'DOCKER_CONFIG')).toContain(
      'anonymous-docker'
    )
    expect(stringField(signatureEnvironment, 'COSIGN_VERIFY_ERROR')).toContain(
      'runner.temp'
    )
    const signatureCommand = stringField(signatureVerification, 'run')
    expect(signatureCommand).toContain('local max_attempts=18')
    expect(signatureCommand).toContain('local retry_delay_seconds=10')
    expect(signatureCommand).toContain('cosign verify')
    expect(signatureCommand).toContain('--certificate-identity "$identity"')
    expect(signatureCommand).toContain(
      "'https://token.actions.githubusercontent.com'"
    )
    expect(signatureCommand).toContain('attempt == max_attempts')
    expect(signatureCommand).toContain('return 1')
    expect(signatureCommand).toContain('sleep "$retry_delay_seconds"')
    expect(signatureCommand).not.toContain('|| true')
    expect(finalSteps.at(-1)?.name).toBe('Verify immutable signatures')
    expect(finalStepIndex('Update Docker Hub description')).toBe(-1)
    expect(releaseSource).not.toContain('hub.docker.com/v2/users/login')
    expect(releaseSource).not.toContain('full_description')

    const publicVerification = finalSteps[
      finalStepIndex(
        'Verify anonymous multi-platform index artifacts before signing'
      )
    ] as LooseRecord
    const publicEnvironment = asRecord(
      publicVerification.env,
      'anonymous verification environment'
    )
    expect(stringField(publicEnvironment, 'DOCKER_CONFIG')).toContain(
      'anonymous-docker'
    )
    expect(stringField(publicEnvironment, 'EXPECTED_BUILDER_RUN')).toBe(
      `https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}`
    )
    expect(stringField(publicEnvironment, 'MAXIMUM_BUILDER_ATTEMPT')).toBe(
      `\${{ github.run_attempt }}`
    )
    const publicCommand = stringField(publicVerification, 'run')
    expect(publicCommand).toContain("--format '{{json .SBOM}}'")
    expect(publicCommand).toContain("--format '{{json .Provenance}}'")
    expect(publicCommand).toContain('verify-container-publication.mjs')
    expect(publicCommand).toContain('--platform-metadata "$VERIFIED_METADATA"')
    expect(publicCommand).toContain('--builder-run-id "$EXPECTED_BUILDER_RUN"')
    expect(publicCommand).not.toContain('--builder-id-prefix')

    const runtimeMatrix = asRecord(
      asRecord(runtime.strategy, 'runtime strategy').matrix,
      'runtime matrix'
    )
    expect(runtimeMatrix.include).toEqual([
      { platform: 'linux/amd64', os: 'ubuntu-22.04', runner_arch: 'X64' },
      { platform: 'linux/arm64', os: 'ubuntu-22.04-arm', runner_arch: 'ARM64' },
    ])
    const runtimeSteps = jobSteps(runtime)
    const publicSmoke = stringField(
      runtimeSteps.find(
        (step) =>
          step.name === 'Smoke immutable public index on native platform'
      ) as LooseRecord,
      'run'
    )
    expect(publicSmoke).toContain('smoke-server-image.mjs')
    expect(publicSmoke).toContain('"$DOCKERHUB_REPOSITORY" "$GHCR_REPOSITORY"')
    expect(publicSmoke).toContain('--platform "$PLATFORM"')
    expect(publicSmoke).not.toContain('--mode health')

    const promoteSteps = jobSteps(promote)
    expect(stringField(promote, 'if')).toContain(
      "needs.preflight.outputs.container_prerelease != 'true'"
    )
    expect(promoteSteps.at(-1)?.name).toBe(
      'Promote and verify stable container aliases last'
    )
    const revalidateAliases = stringField(
      promoteSteps.find(
        (step) =>
          step.name === 'Revalidate immutable inputs before alias promotion'
      ) as LooseRecord,
      'run'
    )
    expect(revalidateAliases).toContain('cosign verify')
    expect(revalidateAliases).toContain('PUBLISHED_DIGEST')
    const aliasCommand = stringField(promoteSteps.at(-1) as LooseRecord, 'run')
    expect(aliasCommand).toContain('imagetools create')
    expect(aliasCommand).toContain('all_tags')
    expect(aliasCommand).toContain('PUBLISHED_DIGEST')

    expect(releaseSource).not.toMatch(/qemu|setup-qemu|binfmt/i)
    const jobsWithDockerHubToken = Object.entries(jobs)
      .filter(([, job]) => JSON.stringify(job).includes('DOCKERHUB_TOKEN'))
      .map(([name]) => name)
      .sort()
    expect(jobsWithDockerHubToken).toEqual([
      'build-container-platform',
      'promote-container-aliases',
      'publish-container',
    ])
  })

  it('bounds anonymous signature visibility retries and still fails closed', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const containerJob = asRecord(
      jobs['publish-container'],
      'publish-container job'
    )
    const signatureCommand = stringField(
      jobSteps(containerJob).find(
        (step) => step.name === 'Verify immutable signatures'
      ) as LooseRecord,
      'run'
    )
    const fixture = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'motrix-cosign-retry-'))
    )
    const binaryDirectory = path.join(fixture, 'bin')
    const countPath = path.join(fixture, 'cosign-count')
    const errorPath = path.join(fixture, 'cosign-error')
    mkdirSync(binaryDirectory)
    writeFileSync(
      path.join(binaryDirectory, 'cosign'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'count=0',
        'if [[ -f "$MOTRIX_FAKE_COSIGN_COUNT" ]]; then',
        '  read -r count < "$MOTRIX_FAKE_COSIGN_COUNT"',
        'fi',
        'count=$((count + 1))',
        'printf \'%s\\n\' "$count" > "$MOTRIX_FAKE_COSIGN_COUNT"',
        'if (( count <= MOTRIX_FAKE_COSIGN_FAILURES )); then',
        '  echo "no signatures found" >&2',
        '  exit 10',
        'fi',
      ].join('\n'),
      { mode: 0o755 }
    )
    writeFileSync(path.join(binaryDirectory, 'sleep'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    })
    const runVerification = (failures: number) => {
      writeFileSync(countPath, '0\n')
      return spawnSync('bash', ['-c', signatureCommand], {
        encoding: 'utf8',
        env: {
          ...process.env,
          COSIGN_VERIFY_ERROR: errorPath,
          DOCKERHUB_REPOSITORY: 'docker.io/motrixapp/motrix-server',
          GHCR_REPOSITORY: 'ghcr.io/agalwood/motrix-server',
          GITHUB_REF_NAME: 'v2.0.0-beta.13',
          MOTRIX_FAKE_COSIGN_COUNT: countPath,
          MOTRIX_FAKE_COSIGN_FAILURES: String(failures),
          PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
          PUBLISHED_DIGEST: `sha256:${'a'.repeat(64)}`,
        },
      })
    }

    try {
      const converged = runVerification(2)
      expect(converged.status).toBe(0)
      expect(readFileSync(countPath, 'utf8').trim()).toBe('4')

      const exhausted = runVerification(100)
      expect(exhausted.status).toBe(1)
      expect(readFileSync(countPath, 'utf8').trim()).toBe('18')
      expect(exhausted.stderr).toContain('no signatures found')
    } finally {
      rmSync(fixture, { force: true, recursive: true })
    }
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
    expect(stringField(environment, 'RELEASE_CHANNEL')).toContain(
      'needs.preflight.outputs.channel'
    )

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
    expect(assetsCommand).toContain(`s3://\${R2_BUCKET}/`)
    expect(assetsCommand).not.toContain('/releases/')
    const manifestsCommand = stringField(
      steps[manifestsIndex] as LooseRecord,
      'run'
    )
    expect(manifestsCommand).toContain(`s3://\${R2_BUCKET}/`)
    expect(manifestsCommand).not.toContain('/releases/')
    expect(manifestsCommand).toContain("--include 'latest*.yml'")
    expect(manifestsCommand).toContain("--include 'beta*.yml'")
    expect(manifestsCommand).toContain("--exclude '*'")
    expect(manifestsCommand).toContain('no-cache')

    const validation = steps.find(
      (step) => step.name === 'Validate update feed credentials'
    )
    const validationCommand = stringField(validation as LooseRecord, 'run')
    expect(validationCommand).toContain("R2_BUCKET\" != 'motrix-releases'")

    const verification = steps.find(
      (step) => step.name === 'Verify channel manifests through dl.motrix.app'
    )
    const verificationCommand = stringField(verification as LooseRecord, 'run')
    expect(verificationCommand).toContain('aws s3api head-object')
    expect(verificationCommand).toContain('https://dl.motrix.app/releases/')
    expect(verificationCommand).toContain('sha256sum')
    expect(verificationCommand).toContain('beta) expected_count=4')
    expect(verificationCommand).toContain('stable) expected_count=8')

    const nativeMetadata = steps.find(
      (step) =>
        step.name === 'Verify native AppImage update metadata distribution'
    )
    const nativeMetadataCommand = stringField(
      nativeMetadata as LooseRecord,
      'run'
    )
    expect(nativeMetadataCommand).toContain('release/*.AppImage.zsync')
    expect(nativeMetadataCommand).toContain('dl.motrix.app/releases/')
    expect(nativeMetadataCommand).toContain(
      'github.com/agalwood/Motrix/releases/download/'
    )
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

  it('builds AppImage, deb, and rpm Linux release assets', () => {
    const linuxTargets = targetMatrix(releaseWorkflow).entries.filter(
      (entry) => entry.platform === 'linux'
    )

    expect(linuxTargets).toHaveLength(2)
    for (const entry of linuxTargets) {
      const args = stringField(entry, 'electron_builder_args')
      expect(args).toMatch(/\bAppImage\b/)
      expect(args).toMatch(/\bdeb\b/)
      expect(args).toMatch(/\brpm\b/)
      expect(args).not.toMatch(/\bsnap\b/i)
    }
    expect(releaseSource).toContain(`\${{ matrix.electron_builder_args }}`)
    expect(releaseSource).toContain('release/*.AppImage')

    const buildJob = targetMatrix(releaseWorkflow).job
    const buildSteps = jobSteps(buildJob)
    const toolInstall = buildSteps.find(
      (step) => step.name === 'Install Linux packaging tools'
    )
    expect(stringField(toolInstall as LooseRecord, 'run')).toContain('zsync')
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
    expect(verificationCommand).toContain('release/*.AppImage')

    const appImageVerification = jobSteps(buildJob).find(
      (step) => step.name === 'Verify AppImage artifact'
    )
    expect(appImageVerification).toBeDefined()
    expect(stringField(appImageVerification as LooseRecord, 'if')).toContain(
      "matrix.platform == 'linux'"
    )
    expect(stringField(appImageVerification as LooseRecord, 'run')).toContain(
      'scripts/verify-appimage-artifact.mjs'
    )

    const cleanSmoke = buildSteps.find(
      (step) => step.name === 'Smoke test AppImage without system FUSE2'
    )
    const cleanSmokeCommand = stringField(cleanSmoke as LooseRecord, 'run')
    expect(cleanSmokeCommand).toContain('docker run --rm --network none')
    expect(cleanSmokeCommand).toContain('[[ ! -e /dev/fuse ]]')
    expect(cleanSmokeCommand).toContain('libfuse.so.2')
    expect(cleanSmokeCommand).toContain('--appimage-updateinformation')
    expect(cleanSmokeCommand).toMatch(
      /--appimage-extract \\\n\s+motrix\.desktop/
    )
    expect(cleanSmokeCommand).toContain('test -f squashfs-root/motrix.desktop')
    expect(cleanSmokeCommand).not.toContain('app.motrix.native.desktop')

    const upload = buildSteps.find(
      (step) => step.name === 'Upload target release input'
    )
    const uploadPaths = stringField(
      asRecord(upload?.with, 'release upload'),
      'path'
    )
    expect(uploadPaths).toContain('release/*.AppImage.zsync')
  })

  it('pins the modern AppImage toolset and finalization hook', () => {
    const builderConfig = asRecord(
      JSON.parse(
        readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8')
      ) as unknown,
      'electron-builder config'
    )
    expect(
      stringField(asRecord(builderConfig.toolsets, 'toolsets'), 'appimage')
    ).toBe('1.0.3')
    expect(stringField(builderConfig, 'artifactBuildCompleted')).toBe(
      './scripts/finalize-appimage-artifact.mjs'
    )
    const packageJson = asRecord(
      JSON.parse(
        readFileSync(path.join(ROOT, 'package.json'), 'utf8')
      ) as unknown,
      'package.json'
    )
    expect(
      stringField(
        asRecord(packageJson.devDependencies, 'dev dependencies'),
        'electron-builder'
      )
    ).toBe('26.15.7')
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
    const jobs = workflowJobs(releaseWorkflow)
    const build = asRecord(jobs.build, 'build job')
    expect(
      stringField(asRecord(build.environment, 'build environment'), 'name')
    ).toBe('release-build')
    expect(JSON.stringify(build)).not.toContain('secrets.')

    const sign = asRecord(jobs.sign, 'sign job')
    expect(stringField(sign, 'if')).toContain("github.event_name == 'push'")
    expect(jobNeeds(sign)).toEqual(
      expect.arrayContaining(['preflight', 'build'])
    )
    const entries = matrixEntries(sign, 'sign')
    expect(entries.map((entry) => stringField(entry, 'target')).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'win32-x64']
    )
    for (const entry of entries) {
      expect(stringField(entry, 'electron_sha256')).toMatch(/^[0-9a-f]{64}$/)
    }

    const steps = jobSteps(sign)
    expect(JSON.stringify(steps)).not.toContain('actions/checkout@')
    expect(releaseSource).not.toContain('downloadBuilderToolset')
    const verifyIndex = steps.findIndex(
      (step) => step.name === 'Verify signing input before secrets'
    )
    const electronIndex = steps.findIndex(
      (step) => step.name === 'Download digest-pinned Electron distribution'
    )
    const firstSecretIndex = steps.findIndex((step) =>
      JSON.stringify(step).includes('secrets.')
    )
    const installIndex = steps.findIndex(
      (step) => step.name === 'Install exact signing dependency closure'
    )
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThan(verifyIndex)
    expect(electronIndex).toBeGreaterThan(installIndex)
    expect(electronIndex).toBeGreaterThan(verifyIndex)
    expect(firstSecretIndex).toBeGreaterThan(electronIndex)
    expect(JSON.stringify(steps.slice(0, firstSecretIndex))).not.toContain(
      'secrets.'
    )

    const install = steps[installIndex]!
    const installCommand = stringField(install, 'run')
    expect(stringField(install, 'id')).toBe('signing-tool-runtime')
    expect(stringField(install, 'shell')).toBe('node {0}')
    expect(installCommand).toContain('process.env.SIGNING_TOOL_PARENT')
    expect(installCommand).toContain('fs.mkdtempSync')
    expect(installCommand).toContain(
      "path.join('signing-input', 'signing-tool', name)"
    )
    expect(installCommand).not.toContain(
      "path.join('signing-input', 'package.json')"
    )
    expect(installCommand).toContain("'ci'")
    expect(installCommand).toContain('--ignore-scripts')
    expect(installCommand).not.toContain('npm install')
    expect(installCommand).toContain("process.env.ComSpec || 'cmd.exe'")
    expect(installCommand).toContain(
      "['/d', '/s', '/c', 'npm.cmd', ...npmArgs]"
    )
    expect(installCommand).toContain(": 'npm'")
    expect(installCommand).toContain('shell: false')
    expect(installCommand).not.toContain('shell: true')
    const installEnvironment = asRecord(
      install.env,
      'signing tool runtime environment'
    )
    expect(stringField(installEnvironment, 'SIGNING_TOOL_PARENT')).toContain(
      'runner.temp'
    )

    const builderSteps = steps.filter((step) =>
      stringField(step, 'name').startsWith('Electron Builder (')
    )
    const macStep = platformBuilderStep(builderSteps, 'darwin')
    const windowsStep = platformBuilderStep(builderSteps, 'win32')
    const macEnv = asRecord(macStep.env, 'macOS builder environment')
    const windowsEnv = asRecord(windowsStep.env, 'Windows builder environment')
    expect(stringField(macEnv, 'CSC_KEYCHAIN')).toContain(
      'steps.mac-keychain.outputs.path'
    )
    expect(macEnv).not.toHaveProperty('CSC_LINK')
    expect(macEnv).not.toHaveProperty('CSC_KEY_PASSWORD')
    expect(stringField(macEnv, 'ELECTRON_BUILDER_CLI')).toContain(
      'steps.signing-tool-runtime.outputs.cli'
    )
    expect(JSON.stringify(macEnv)).not.toContain('WIN_CSC')
    const macCommand = stringField(macStep, 'run')
    const macBuilderIndex = macCommand.indexOf('node "$ELECTRON_BUILDER_CLI"')
    expect(macBuilderIndex).toBeGreaterThanOrEqual(0)
    for (const variable of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
      const unsetIndex = macCommand.indexOf(`unset ${variable}`)
      expect(unsetIndex, variable).toBeGreaterThanOrEqual(0)
      expect(unsetIndex, variable).toBeLessThan(macBuilderIndex)
    }

    expect(windowsEnv).not.toHaveProperty('CSC_LINK')
    expect(windowsEnv).not.toHaveProperty('CSC_KEY_PASSWORD')
    expect(stringField(windowsEnv, 'CSC_IDENTITY_AUTO_DISCOVERY')).toBe('false')
    expect(stringField(windowsEnv, 'ELECTRON_BUILDER_CLI')).toContain(
      'steps.signing-tool-runtime.outputs.cli'
    )
    expect(JSON.stringify(windowsEnv)).not.toContain('MAC_CERTS')
    expect(stringField(windowsStep, 'if')).toBe("matrix.platform == 'win32'")
    const windowsCommand = stringField(windowsStep, 'run')
    const builderIndex = windowsCommand.indexOf(
      'node $env:ELECTRON_BUILDER_CLI'
    )
    expect(builderIndex).toBeGreaterThanOrEqual(0)
    for (const variable of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
      const unsetIndex = windowsCommand.indexOf(
        `Remove-Item Env:${path.win32.sep}${variable} -ErrorAction SilentlyContinue`
      )
      expect(unsetIndex, variable).toBeGreaterThanOrEqual(0)
      expect(unsetIndex, variable).toBeLessThan(builderIndex)
    }
    expect(JSON.stringify(sign)).not.toContain('WIN_CSC')
    expect(JSON.stringify(sign)).not.toContain('Get-AuthenticodeSignature')
    expect(steps.map((step) => step.name)).not.toContain(
      'Verify Windows signatures'
    )

    const packageVerification = steps.find(
      (step) => step.name === 'Verify finalized Electron package'
    )
    const finalizedUpload = steps.find(
      (step) => step.name === 'Upload finalized release input'
    )
    expect(packageVerification).toBeDefined()
    expect(finalizedUpload).toBeDefined()
    expect(stringField(packageVerification as LooseRecord, 'if', '')).toBe('')
    expect(stringField(finalizedUpload as LooseRecord, 'if', '')).toBe('')

    expect(releaseSource).toContain('APPLE_API_ISSUER')
    expect(releaseSource).not.toContain('secrets.TEAM_ID')
    expect(releaseSource).not.toContain('APPLE_TEAM_ID')
  })

  it('runs the finalized package verifier from the isolated tool closure', () => {
    const sign = asRecord(workflowJobs(releaseWorkflow).sign, 'sign job')
    const steps = jobSteps(sign)
    const installIndex = steps.findIndex(
      (step) => step.name === 'Install exact signing dependency closure'
    )
    const credentialCleanupIndex = steps.findIndex(
      (step) => step.name === 'Remove finalization credentials'
    )
    const verificationIndex = steps.findIndex(
      (step) => step.name === 'Verify finalized Electron package'
    )
    const uploadIndex = steps.findIndex(
      (step) => step.name === 'Upload finalized release input'
    )
    const runtimeCleanupIndex = steps.findIndex(
      (step) => step.name === 'Remove isolated signing runtime'
    )
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(credentialCleanupIndex).toBeGreaterThan(installIndex)
    for (const name of [
      'Electron Builder (macOS signing boundary)',
      'Electron Builder (Windows finalization boundary)',
    ]) {
      const builderIndex = steps.findIndex((step) => step.name === name)
      expect(builderIndex, name).toBeGreaterThan(installIndex)
      expect(builderIndex, name).toBeLessThan(credentialCleanupIndex)
    }
    expect(verificationIndex).toBeGreaterThan(credentialCleanupIndex)
    expect(runtimeCleanupIndex).toBeGreaterThan(verificationIndex)
    expect(uploadIndex).toBeGreaterThan(runtimeCleanupIndex)

    const verifierFiles = [
      'electron-package-size-budgets.json',
      'electron-package-utils.mjs',
      'native-binary-target.mjs',
      'verify-electron-package.mjs',
    ]
    const install = steps[installIndex]!
    const installSource = stringField(install, 'run')
    expect(installSource).toContain("path.join(root, 'scripts')")
    expect(installSource).toContain('fs.constants.COPYFILE_EXCL')
    expect(installSource).toContain('fs.realpathSync')
    expect(installSource).toContain(`verifier=\${verifier}`)
    expect(installSource).toContain('pathToFileURL(verifier).href')
    expect(installSource).toContain(
      "throw new Error('package verifier dependency import failed')"
    )
    expect(installSource).not.toContain(
      "path.join('signing-input', 'node_modules')"
    )
    const trustedPins = signingInputSource.slice(
      signingInputSource.indexOf('const TRUSTED_INPUT_SHA256'),
      signingInputSource.indexOf('const SOURCE_MAPPINGS')
    )
    const sourceMappings = signingInputSource.slice(
      signingInputSource.indexOf('const SOURCE_MAPPINGS'),
      signingInputSource.indexOf('async function sha256File')
    )
    const allowedPaths = signingInputSource.slice(
      signingInputSource.indexOf('function isAllowedSigningDataPath'),
      signingInputSource.indexOf('function isForbiddenControlPath')
    )
    for (const name of verifierFiles) {
      expect(installSource, name).toContain(`'${name}'`)
      const trustedPath = `'scripts/${name}'`
      const pinIndex = trustedPins.indexOf(trustedPath)
      expect(pinIndex, `${name} must be hard-pinned`).toBeGreaterThanOrEqual(0)
      expect(
        trustedPins.slice(pinIndex + trustedPath.length, pinIndex + 160),
        `${name} must have a SHA-256 pin`
      ).toMatch(/^\s*:\s*'[0-9a-f]{64}'/u)
      expect(sourceMappings.split(trustedPath), name).toHaveLength(3)
      expect(allowedPaths, name).toContain(trustedPath)
    }

    const verification = steps[verificationIndex]!
    const verificationSource = stringField(verification, 'run')
    expect(verificationSource).toContain(
      'steps.signing-tool-runtime.outputs.verifier'
    )
    expect(verificationSource).not.toContain(
      'node scripts/verify-electron-package.mjs'
    )
    expect(stringField(verification, 'if', '')).toBe('')
    expect(stringField(verification, 'working-directory')).toBe('signing-input')
    expect(
      readFileSync(
        path.join(ROOT, 'scripts/verify-electron-package.mjs'),
        'utf8'
      )
    ).toMatch(
      /path\.join\(\s*REPOSITORY_ROOT,\s*'scripts\/electron-package-size-budgets\.json'\s*\)/u
    )

    const fixture = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'motrix-isolated-package-verifier-'))
    )
    const signingInput = path.join(fixture, 'signing-input')
    const runtime = path.join(fixture, 'runtime')
    const stageVerifier = (root: string) => {
      const scripts = path.join(root, 'scripts')
      mkdirSync(scripts, { recursive: true })
      for (const name of verifierFiles) {
        writeFileSync(
          path.join(scripts, name),
          readFileSync(path.join(ROOT, 'scripts', name))
        )
      }
      return path.join(scripts, 'verify-electron-package.mjs')
    }
    const importVerifier = (verifier: string) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(pathToFileURL(verifier).href)})`,
        ],
        { cwd: signingInput, encoding: 'utf8' }
      )

    try {
      const inaccessibleVerifier = stageVerifier(signingInput)
      const inaccessible = importVerifier(inaccessibleVerifier)
      expect(inaccessible.status).not.toBe(0)
      expect(`${inaccessible.stdout}${inaccessible.stderr}`).toContain(
        "Cannot find package '@electron/asar'"
      )

      const isolatedVerifier = stageVerifier(runtime)
      const installedNodeModules = path.join(ROOT, 'node_modules')
      expect(existsSync(installedNodeModules)).toBe(true)
      symlinkSync(
        installedNodeModules,
        path.join(runtime, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      for (const name of [
        'package.json',
        'package-lock.json',
        'node_modules',
      ]) {
        expect(existsSync(path.join(signingInput, name)), name).toBe(false)
      }
      const signingToolPackages = asRecord(
        asRecord(
          JSON.parse(signingToolLockSource) as unknown,
          'signing tool lock'
        ).packages,
        'signing tool lock packages'
      )
      const lockedAsar = asRecord(
        signingToolPackages['node_modules/@electron/asar'],
        'locked @electron/asar package'
      )
      const installedAsar = asRecord(
        JSON.parse(
          readFileSync(
            path.join(installedNodeModules, '@electron/asar/package.json'),
            'utf8'
          )
        ) as unknown,
        'installed @electron/asar package'
      )
      expect(stringField(installedAsar, 'version')).toBe(
        stringField(lockedAsar, 'version')
      )
      const isolated = importVerifier(isolatedVerifier)
      expect(isolated.status, isolated.stderr).toBe(0)

      const report = 'isolated-runtime-smoke-report.json'
      const execution = spawnSync(
        process.execPath,
        [
          isolatedVerifier,
          '--app-dir',
          'missing-app',
          '--platform',
          'win32',
          '--arch',
          'x64',
          '--report',
          report,
        ],
        { cwd: signingInput, encoding: 'utf8' }
      )
      expect(execution.status).not.toBe(0)
      expect(execution.stdout).toContain(
        '[verify-electron-package] failed win32-x64'
      )
      expect(`${execution.stdout}${execution.stderr}`).not.toContain(
        'electron-package-size-budgets.json'
      )
      expect(`${execution.stdout}${execution.stderr}`).not.toContain(
        "Cannot find package '@electron/asar'"
      )
      const reportPath = path.join(signingInput, report)
      expect(existsSync(reportPath)).toBe(true)
      const reportTools = asRecord(
        asRecord(
          JSON.parse(readFileSync(reportPath, 'utf8')) as unknown,
          'isolated verifier report'
        ).tools,
        'isolated verifier tool versions'
      )
      expect(stringField(reportTools, 'asar')).toBe(
        stringField(lockedAsar, 'version')
      )
      expect(stringField(reportTools, 'electronBuilder')).toBe(
        stringField(
          asRecord(
            signingToolPackages['node_modules/electron-builder'],
            'locked electron-builder package'
          ),
          'version'
        )
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('uses separate certificate and keychain passwords in an isolated keychain', () => {
    const sign = asRecord(workflowJobs(releaseWorkflow).sign, 'sign job')
    const steps = jobSteps(sign)
    const preparation = steps.find(
      (step) => step.name === 'Prepare isolated macOS signing certificate'
    )
    expect(preparation).toBeDefined()
    expect(stringField(preparation as LooseRecord, 'shell')).toBe('node {0}')
    expect(stringField(preparation as LooseRecord, 'if')).toBe(
      "matrix.platform == 'darwin'"
    )
    const preparationEnvironment = asRecord(
      preparation?.env,
      'macOS certificate preparation environment'
    )
    expect(stringField(preparationEnvironment, 'MAC_CERTS_BASE64')).toContain(
      'secrets.MAC_CERTS'
    )
    expect(stringField(preparationEnvironment, 'CERTIFICATE_PARENT')).toContain(
      'runner.temp'
    )
    const source = stringField(preparation as LooseRecord, 'run')
    expect(source).toContain('maximumEncodedBytes')
    expect(source).toContain('maximumCertificateBytes')
    expect(source).toContain('fs.mkdtempSync')
    expect(source).toContain('mode: 0o600')
    expect(source).toContain("flag: 'wx'")
    expect(source).not.toContain('console.')
    expect(source).not.toContain('process.stdout')

    const keychainPreparation = steps.find(
      (step) => step.name === 'Prepare isolated macOS signing keychain'
    )
    expect(keychainPreparation).toBeDefined()
    expect(stringField(keychainPreparation as LooseRecord, 'id')).toBe(
      'mac-keychain'
    )
    expect(stringField(keychainPreparation as LooseRecord, 'shell')).toBe(
      'node {0}'
    )
    expect(stringField(keychainPreparation as LooseRecord, 'if')).toBe(
      "matrix.platform == 'darwin'"
    )
    const keychainEnvironment = asRecord(
      keychainPreparation?.env,
      'macOS keychain preparation environment'
    )
    expect(stringField(keychainEnvironment, 'MAC_CERTIFICATE_PATH')).toContain(
      'steps.mac-certificate.outputs.path'
    )
    expect(stringField(keychainEnvironment, 'MAC_CERTS_PASSWORD')).toContain(
      'secrets.MAC_CERTS_PASSWORD'
    )
    expect(stringField(keychainEnvironment, 'KEYCHAIN_PARENT')).toContain(
      'runner.temp'
    )
    const keychainSource = stringField(
      keychainPreparation as LooseRecord,
      'run'
    )
    expect(keychainSource).toContain(
      "crypto.randomBytes(48).toString('base64url')"
    )
    expect(keychainSource).toContain(
      'while (keychainPassword === certificatePassword)'
    )
    expect(keychainSource).toContain(
      "'create-keychain', '-p', keychainPassword"
    )
    expect(keychainSource).toContain(
      "'unlock-keychain', '-p', keychainPassword"
    )
    expect(keychainSource).toMatch(/'-P',\s*certificatePassword/u)
    expect(keychainSource).toMatch(/'-k',\s*keychainPassword/u)
    expect(keychainSource).toContain(
      "'find-identity', '-v', '-p', 'codesigning'"
    )
    expect(keychainSource).toContain('original-keychains.json')
    expect(keychainSource).toContain('mode: 0o600')
    expect(keychainSource).not.toContain('console.')
    expect(keychainSource).not.toContain('process.stdout')

    const macCodeSignSource = readFileSync(
      require.resolve('app-builder-lib/out/codeSign/macCodeSign.js'),
      'utf8'
    )
    const macPackagerSource = readFileSync(
      require.resolve('app-builder-lib/out/macPackager.js'),
      'utf8'
    )
    expect(macCodeSignSource).toContain(
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]'
    )
    expect(macPackagerSource).toContain('process.env.CSC_KEYCHAIN || null')

    const temporaryRoot = mkdtempSync(
      path.join(tmpdir(), 'motrix-mac-certificate-contract-')
    )
    let run = 0
    const execute = (encoded: string) => {
      run += 1
      const output = path.join(temporaryRoot, `github-output-${run}`)
      writeFileSync(output, '')
      const result = spawnSync(process.execPath, ['-e', source], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CERTIFICATE_PARENT: temporaryRoot,
          GITHUB_OUTPUT: output,
          MAC_CERTS_BASE64: encoded,
        },
      })
      const values = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf('=')
            return [line.slice(0, separator), line.slice(separator + 1)]
          })
      )
      return { result, values }
    }

    try {
      const certificate = Buffer.alloc(1532)
      certificate.set([0x30, 0x82, 0x05, 0xf8, 0x02, 0x01, 0x03, 0x30])
      const padded = certificate.toString('base64')
      const unpadded = padded.replace(/=+$/u, '')
      expect(unpadded).toHaveLength(2043)

      for (const encoded of [padded, unpadded]) {
        const { result, values } = execute(encoded)
        expect(result.status, result.stderr).toBe(0)
        const certificatePath = values.path
        expect(certificatePath).toBeDefined()
        expect(readFileSync(certificatePath!)).toEqual(certificate)
        expect(statSync(certificatePath!).mode & 0o777).toBe(0o600)
        expect(path.dirname(certificatePath!)).toBe(values.directory)
      }

      for (const encoded of [
        '',
        'A',
        'AB',
        'AA-_',
        ` ${padded}`,
        `${padded}\n`,
        'A'.repeat(128 * 1024 + 4),
        Buffer.from([0x30, 0x00]).toString('base64'),
      ]) {
        const { result } = execute(encoded)
        expect(result.status).not.toBe(0)
        if (encoded) {
          expect(`${result.stdout}${result.stderr}`).not.toContain(encoded)
        }
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }

    const credentialCleanup = steps.find(
      (step) => step.name === 'Remove finalization credentials'
    )
    expect(credentialCleanup).toBeDefined()
    expect(stringField(credentialCleanup as LooseRecord, 'if')).toBe('always()')
    expect(stringField(credentialCleanup as LooseRecord, 'shell')).toBe(
      'node {0}'
    )
    const credentialCleanupEnvironment = asRecord(
      credentialCleanup?.env,
      'credential cleanup environment'
    )
    expect(
      stringField(credentialCleanupEnvironment, 'TEMPORARY_ROOT')
    ).toContain('runner.temp')
    expect(
      stringField(credentialCleanupEnvironment, 'MAC_CERTIFICATE_PATH')
    ).toContain('steps.mac-certificate.outputs.path')
    expect(
      stringField(credentialCleanupEnvironment, 'MAC_CERTIFICATE_DIRECTORY')
    ).toContain('steps.mac-certificate.outputs.directory')
    expect(
      stringField(credentialCleanupEnvironment, 'APPLE_API_KEY_PATH')
    ).toContain('steps.apple-api-key.outputs.path')
    expect(
      stringField(credentialCleanupEnvironment, 'MAC_KEYCHAIN_PATH')
    ).toContain('steps.mac-keychain.outputs.path')
    expect(
      stringField(credentialCleanupEnvironment, 'MAC_KEYCHAIN_DIRECTORY')
    ).toContain('steps.mac-keychain.outputs.directory')
    expect(
      stringField(credentialCleanupEnvironment, 'MAC_ORIGINAL_KEYCHAIN_LIST')
    ).toContain('steps.mac-keychain.outputs.original_list')
    expect(credentialCleanupEnvironment).not.toHaveProperty('SIGNING_TOOL_ROOT')
    expect(JSON.stringify(credentialCleanup)).not.toContain('secrets.')
    const credentialCleanupSource = stringField(
      credentialCleanup as LooseRecord,
      'run'
    )
    expect(credentialCleanupSource).toContain('path.relative(root, candidate)')
    expect(credentialCleanupSource).toContain('fs.rmSync')
    expect(credentialCleanupSource).toContain(
      "['list-keychains', '-d', 'user', '-s', ...originalKeychains]"
    )
    expect(credentialCleanupSource).toContain(
      "['delete-keychain', keychainPath]"
    )

    const runtimeCleanup = steps.find(
      (step) => step.name === 'Remove isolated signing runtime'
    )
    expect(runtimeCleanup).toBeDefined()
    expect(stringField(runtimeCleanup as LooseRecord, 'if')).toBe('always()')
    expect(stringField(runtimeCleanup as LooseRecord, 'shell')).toBe('node {0}')
    const runtimeCleanupEnvironment = asRecord(
      runtimeCleanup?.env,
      'signing runtime cleanup environment'
    )
    expect(stringField(runtimeCleanupEnvironment, 'TEMPORARY_ROOT')).toContain(
      'runner.temp'
    )
    expect(
      stringField(runtimeCleanupEnvironment, 'SIGNING_TOOL_ROOT')
    ).toContain('steps.signing-tool-runtime.outputs.root')
    expect(runtimeCleanupEnvironment).not.toHaveProperty('APPLE_API_KEY_PATH')
    expect(runtimeCleanupEnvironment).not.toHaveProperty('MAC_CERTIFICATE_PATH')
    expect(JSON.stringify(runtimeCleanup)).not.toContain('secrets.')
    const runtimeCleanupSource = stringField(
      runtimeCleanup as LooseRecord,
      'run'
    )
    expect(runtimeCleanupSource).toContain('path.relative(root, candidate)')
    expect(runtimeCleanupSource).toContain('fs.rmSync')

    const cleanupRoot = mkdtempSync(
      path.join(tmpdir(), 'motrix-finalization-cleanup-contract-')
    )
    try {
      const apiKey = path.join(cleanupRoot, 'AuthKey.p8')
      const certificateDirectory = path.join(cleanupRoot, 'certificate')
      const certificate = path.join(certificateDirectory, 'identity.p12')
      const keychainDirectory = path.join(cleanupRoot, 'keychain')
      const keychain = path.join(keychainDirectory, 'signing.keychain-db')
      const originalKeychains = path.join(
        keychainDirectory,
        'original-keychains.json'
      )
      const signingTool = path.join(cleanupRoot, 'signing-tool')
      mkdirSync(certificateDirectory)
      mkdirSync(keychainDirectory)
      mkdirSync(signingTool)
      writeFileSync(apiKey, 'api key')
      writeFileSync(certificate, 'certificate')
      writeFileSync(keychain, 'keychain')
      writeFileSync(originalKeychains, '[]')
      writeFileSync(path.join(signingTool, 'package.json'), '{}')
      const credentialResult = spawnSync(
        process.execPath,
        ['-e', credentialCleanupSource],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLE_API_KEY_PATH: apiKey,
            MAC_CERTIFICATE_DIRECTORY: certificateDirectory,
            MAC_CERTIFICATE_PATH: certificate,
            MAC_KEYCHAIN_DIRECTORY: keychainDirectory,
            MAC_KEYCHAIN_PATH: '',
            MAC_ORIGINAL_KEYCHAIN_LIST: originalKeychains,
            TEMPORARY_ROOT: cleanupRoot,
          },
        }
      )
      expect(credentialResult.status, credentialResult.stderr).toBe(0)
      for (const candidate of [
        apiKey,
        certificate,
        certificateDirectory,
        keychain,
        originalKeychains,
        keychainDirectory,
      ]) {
        expect(existsSync(candidate), candidate).toBe(false)
      }
      expect(existsSync(signingTool)).toBe(true)

      const runtimeResult = spawnSync(
        process.execPath,
        ['-e', runtimeCleanupSource],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            SIGNING_TOOL_ROOT: signingTool,
            TEMPORARY_ROOT: cleanupRoot,
          },
        }
      )
      expect(runtimeResult.status, runtimeResult.stderr).toBe(0)
      expect(existsSync(signingTool)).toBe(false)

      for (const cleanupSource of [
        credentialCleanupSource,
        runtimeCleanupSource,
      ]) {
        const emptyResult = spawnSync(process.execPath, ['-e', cleanupSource], {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLE_API_KEY_PATH: '',
            MAC_CERTIFICATE_DIRECTORY: '',
            MAC_CERTIFICATE_PATH: '',
            MAC_KEYCHAIN_DIRECTORY: '',
            MAC_KEYCHAIN_PATH: '',
            MAC_ORIGINAL_KEYCHAIN_LIST: '',
            SIGNING_TOOL_ROOT: '',
            TEMPORARY_ROOT: cleanupRoot,
          },
        })
        expect(emptyResult.status, emptyResult.stderr).toBe(0)
      }
    } finally {
      rmSync(cleanupRoot, { recursive: true, force: true })
    }
  })

  it('uses the locked 26.15.7 hook to preserve staged dependency placements', async () => {
    const packageMetadata = asRecord(
      require('app-builder-lib/package.json') as unknown,
      'app-builder-lib package metadata'
    )
    expect(stringField(packageMetadata, 'version')).toBe('26.15.7')
    const signingConfig = asRecord(
      JSON.parse(signingConfigSource) as unknown,
      'restricted signing config'
    )
    expect(signingConfig.npmRebuild).toBe(true)
    expect(stringField(signingConfig, 'beforeBuild')).toBe(
      './scripts/before-build-use-staged-dependencies.mjs'
    )

    const fixture = mkdtempSync(
      path.join(tmpdir(), 'motrix-finalizer-staged-dependencies-')
    )
    const signingInput = path.join(fixture, 'signing-input')
    const appDirectory = path.join(signingInput, 'dist', 'electron-app')
    const scriptsDirectory = path.join(signingInput, 'scripts')
    mkdirSync(appDirectory, { recursive: true })
    mkdirSync(scriptsDirectory, { recursive: true })
    writeFileSync(
      path.join(signingInput, 'electron-builder.signing.json'),
      signingConfigSource
    )
    writeFileSync(
      path.join(scriptsDirectory, 'before-build-use-staged-dependencies.mjs'),
      stagedDependenciesHookSource
    )
    writeFileSync(
      path.join(appDirectory, 'package.json'),
      JSON.stringify({ name: 'motrix-stage', private: true })
    )

    try {
      await expect(
        stagedDependenciesBoundary({ appDir: appDirectory })
      ).resolves.toBe(false)
      await expect(
        stagedDependenciesBoundary({
          appDir: path.join(fixture, 'untrusted-app'),
        })
      ).rejects.toThrow(/expected appDir to be dist\/electron-app/u)

      const packagerModule = require.resolve('app-builder-lib/out/packager.js')
      const platformPackagerModule = require.resolve(
        'app-builder-lib/out/platformPackager.js'
      )
      const yarnModule = require.resolve('app-builder-lib/out/util/yarn.js')
      const childSource = `
        const fs = require('node:fs')
        const path = require('node:path')
        const yarn = require(process.env.YARN_MODULE)
        let installCalls = 0
        yarn.installOrRebuild = async () => { installCalls += 1 }
        const { Packager } = require(process.env.PACKAGER_MODULE)
        const { Arch } = require(process.env.BUILDER_UTIL_MODULE)
        const config = JSON.parse(
          fs.readFileSync('electron-builder.signing.json', 'utf8')
        )
        const context = {
          options: {},
          framework: {
            isNpmRebuildRequired: true,
            version: config.electronVersion,
          },
          config,
          appInfo: { type: 'module' },
          appDir: path.resolve('dist/electron-app'),
          getWorkspaceRoot: async () => process.cwd(),
          _nodeModulesHandledExternally: false,
          runtimeEnvironmentVariables: {},
        }
        Packager.prototype.installAppDependencies.call(
          context,
          { nodeName: 'win32' },
          Arch.x64
        ).then(() => {
          process.stdout.write(JSON.stringify({
            handledExternally: context._nodeModulesHandledExternally,
            installCalls,
          }))
        }).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
        })
      `
      const execution = spawnSync(process.execPath, ['-e', childSource], {
        cwd: signingInput,
        encoding: 'utf8',
        env: {
          ...process.env,
          BUILDER_UTIL_MODULE: require.resolve('builder-util'),
          PACKAGER_MODULE: packagerModule,
          YARN_MODULE: yarnModule,
        },
      })
      expect(execution.status, execution.stderr).toBe(0)
      expect(JSON.parse(execution.stdout)).toEqual({
        handledExternally: true,
        installCalls: 0,
      })

      const packagerSource = readFileSync(packagerModule, 'utf8')
      expect(packagerSource).toContain(
        'this._nodeModulesHandledExternally = !performDependenciesInstallOrRebuild'
      )
      const platformPackagerSource = readFileSync(
        platformPackagerModule,
        'utf8'
      )
      expect(platformPackagerSource).toMatch(
        /!this\.info\.areNodeModulesHandledExternally[\s\S]{0,400}computeNodeModuleFileSets/u
      )

      const nestedPlacements = [
        'ajv/node_modules/fast-uri/package.json',
        'electron-updater/node_modules/js-yaml/package.json',
        'electron-updater/node_modules/semver/package.json',
      ]
      for (const relativePath of nestedPlacements) {
        const destination = path.join(
          appDirectory,
          'node_modules',
          relativePath
        )
        mkdirSync(path.dirname(destination), { recursive: true })
        writeFileSync(destination, JSON.stringify({ name: relativePath }))
      }

      const initialConfig = asRecord(
        JSON.parse(
          readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8')
        ) as unknown,
        'initial Electron Builder config'
      )
      expect(signingConfig.asar).toBe(initialConfig.asar)
      expect(signingConfig.asarUnpack).toEqual(initialConfig.asarUnpack)
      expect(signingConfig.files).toEqual(initialConfig.files)
      expect(
        asRecord(signingConfig.directories, 'signing directories').app
      ).toBe(asRecord(initialConfig.directories, 'initial directories').app)
      const findNodeModulesMapping = (config: LooseRecord) =>
        (config.files as unknown[]).find((value) => {
          return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            (value as LooseRecord).from === 'node_modules'
          )
        })
      const signingMapping = asRecord(
        findNodeModulesMapping(signingConfig),
        'signing node_modules mapping'
      )
      expect(signingMapping).toEqual(findNodeModulesMapping(initialConfig))

      const fileMatcherModule = asRecord(
        require('app-builder-lib/out/fileMatcher.js') as unknown,
        'app-builder-lib file matcher module'
      )
      const appFileCopierModule = asRecord(
        require('app-builder-lib/out/util/appFileCopier.js') as unknown,
        'app-builder-lib app file copier module'
      )
      const FileMatcher = fileMatcherModule.FileMatcher as new (
        from: string,
        to: string,
        macroExpander: (value: string) => string,
        patterns: string[]
      ) => unknown
      const computeFileSets = appFileCopierModule.computeFileSets as (
        matchers: unknown[],
        transformer: null,
        platformPackager: {
          info: { areNodeModulesHandledExternally: boolean }
        },
        isElectronCompile: boolean
      ) => Promise<Array<{ destination: string; files: string[]; src: string }>>
      const getDestinationPath = appFileCopierModule.getDestinationPath as (
        file: string,
        fileSet: { destination: string; src: string }
      ) => string
      const stagedNodeModules = path.join(appDirectory, 'node_modules')
      const outputNodeModules = path.join(fixture, 'output', 'node_modules')
      const matcher = new FileMatcher(
        stagedNodeModules,
        outputNodeModules,
        (value) => value,
        signingMapping.filter as string[]
      )
      const fileSets = await computeFileSets(
        [matcher],
        null,
        { info: { areNodeModulesHandledExternally: true } },
        false
      )
      expect(fileSets).toHaveLength(1)
      const selectedPlacements = fileSets[0]!.files
        .map((file) =>
          path
            .relative(outputNodeModules, getDestinationPath(file, fileSets[0]!))
            .split(path.sep)
            .join('/')
        )
        .sort()
      expect(selectedPlacements).toEqual(nestedPlacements)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('passes the signing input commit through a shell-neutral expression', () => {
    const buildSteps = jobSteps(
      asRecord(workflowJobs(releaseWorkflow).build, 'build job')
    )
    const createInput = buildSteps.find(
      (step) => step.name === 'Create isolated signing input'
    )

    expect(createInput).toBeDefined()
    expect(stringField(createInput as LooseRecord, 'if')).toContain(
      "matrix.platform == 'win32'"
    )
    const command = stringField(createInput as LooseRecord, 'run')
    expect(command).toContain(`--commit "\${{ github.sha }}"`)
    expect(command).not.toContain('$GITHUB_SHA')
  })

  it('sanitizes then unsets builder custom directories inside each finalization boundary', () => {
    const signJob = asRecord(workflowJobs(releaseWorkflow).sign, 'sign job')
    const signEnvironment = asRecord(signJob.env, 'sign job environment')
    for (const variable of [
      'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
      'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
    ]) {
      expect(stringField(signEnvironment, variable)).toBe('')
    }

    const steps = jobSteps(signJob)
    const boundaries = [
      {
        name: 'Electron Builder (macOS signing boundary)',
        shell: 'bash',
        builderCommand: 'node "$ELECTRON_BUILDER_CLI"',
        unsetCommand: (variable: string) => `unset ${variable}`,
      },
      {
        name: 'Electron Builder (Windows finalization boundary)',
        shell: 'pwsh',
        builderCommand: 'node $env:ELECTRON_BUILDER_CLI',
        unsetCommand: (variable: string) =>
          `Remove-Item Env:${path.win32.sep}${variable} -ErrorAction SilentlyContinue`,
      },
    ]

    for (const boundary of boundaries) {
      const step = steps.find((candidate) => candidate.name === boundary.name)
      expect(step).toBeDefined()
      expect(stringField(step as LooseRecord, 'shell')).toBe(boundary.shell)
      const command = stringField(step as LooseRecord, 'run')
      const builderIndex = command.indexOf(boundary.builderCommand)
      expect(builderIndex).toBeGreaterThanOrEqual(0)
      for (const variable of ELECTRON_BUILDER_CUSTOM_DIR_ENVIRONMENT_VARIABLES) {
        const unsetIndex = command.indexOf(boundary.unsetCommand(variable))
        expect(
          unsetIndex,
          `${boundary.name} must unset ${variable}`
        ).toBeGreaterThanOrEqual(0)
        expect(unsetIndex).toBeLessThan(builderIndex)
      }
    }
  })

  it('restores canonical 26.15.7 NSIS URLs after custom directories are unset', async () => {
    const signingToolPackages = asRecord(
      asRecord(
        JSON.parse(signingToolLockSource) as unknown,
        'signing tool lock'
      ).packages,
      'signing tool lock packages'
    )
    const lockedAppBuilder = asRecord(
      signingToolPackages['node_modules/app-builder-lib'],
      'locked app-builder-lib package'
    )
    expect(stringField(lockedAppBuilder, 'version')).toBe('26.15.7')

    const packageMetadata = asRecord(
      require('app-builder-lib/package.json') as unknown,
      'app-builder-lib package metadata'
    )
    expect(stringField(packageMetadata, 'version')).toBe('26.15.7')

    const electronGetPath = require.resolve(
      'app-builder-lib/out/util/electronGet.js'
    )
    const binDownloadPath = require.resolve(
      'app-builder-lib/out/binDownload.js'
    )
    const electronGet = asRecord(
      require(electronGetPath) as unknown,
      'app-builder-lib electron downloader'
    )
    const originalDownloadBuilderToolset = electronGet.downloadBuilderToolset
    if (typeof originalDownloadBuilderToolset !== 'function') {
      throw new TypeError('downloadBuilderToolset must be a function')
    }

    const customDirNames = new Set(
      ELECTRON_BUILDER_CUSTOM_DIR_ENVIRONMENT_VARIABLES.map((name) =>
        name.toLowerCase()
      )
    )
    const originalEnvironment = Object.entries(process.env).filter(([name]) =>
      customDirNames.has(name.toLowerCase())
    )
    const clearCustomDirectories = () => {
      for (const name of Object.keys(process.env)) {
        if (customDirNames.has(name.toLowerCase())) {
          delete process.env[name]
        }
      }
    }
    type GetBinFromUrl = (
      releaseName: string,
      filenameWithExt: string,
      checksum: string
    ) => Promise<string>
    const loadGetBinFromUrl = (): GetBinFromUrl => {
      delete require.cache[binDownloadPath]
      const binDownload = asRecord(
        require(binDownloadPath) as unknown,
        'app-builder-lib binary downloader'
      )
      if (typeof binDownload.getBinFromUrl !== 'function') {
        throw new TypeError('getBinFromUrl must be a function')
      }
      return binDownload.getBinFromUrl as GetBinFromUrl
    }

    const downloads: LooseRecord[] = []
    electronGet.downloadBuilderToolset = async (options: unknown) => {
      downloads.push(asRecord(options, 'builder toolset download options'))
      return path.join(ROOT, '.stub-electron-builder-toolset')
    }

    try {
      clearCustomDirectories()
      for (const variable of ELECTRON_BUILDER_CUSTOM_DIR_ENVIRONMENT_VARIABLES) {
        process.env[variable] = ''
      }
      await loadGetBinFromUrl()(
        'nsis-3.0.4.1',
        'nsis-3.0.4.1.7z',
        '0'.repeat(64)
      )

      expect(downloads).toHaveLength(1)
      expect(stringField(downloads[0] as LooseRecord, 'releaseName')).toBe(
        'download'
      )
      expect(stringField(downloads[0] as LooseRecord, 'overrideUrl')).toBe(
        'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
      )

      clearCustomDirectories()
      const getBinFromUrl = loadGetBinFromUrl()
      await getBinFromUrl('nsis-3.0.4.1', 'nsis-3.0.4.1.7z', '0'.repeat(64))
      await getBinFromUrl(
        'nsis-resources-3.4.1',
        'nsis-resources-3.4.1.7z',
        '0'.repeat(64)
      )

      expect(
        downloads.slice(1).map((download) => ({
          filenameWithExt: stringField(download, 'filenameWithExt'),
          overrideUrl: stringField(download, 'overrideUrl'),
          releaseName: stringField(download, 'releaseName'),
        }))
      ).toEqual([
        {
          filenameWithExt: 'nsis-3.0.4.1.7z',
          overrideUrl:
            'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1',
          releaseName: 'nsis-3.0.4.1',
        },
        {
          filenameWithExt: 'nsis-resources-3.4.1.7z',
          overrideUrl:
            'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1',
          releaseName: 'nsis-resources-3.4.1',
        },
      ])
    } finally {
      electronGet.downloadBuilderToolset = originalDownloadBuilderToolset
      delete require.cache[binDownloadPath]
      clearCustomDirectories()
      for (const [name, value] of originalEnvironment) {
        process.env[name] = value
      }
    }
  })

  it('verifies notarization stapling in addition to macOS signatures', () => {
    const signJob = asRecord(workflowJobs(releaseWorkflow).sign, 'sign job')
    const verification = jobSteps(signJob).find(
      (step) => step.name === 'Verify macOS signatures'
    )

    expect(verification).toBeDefined()
    const command = stringField(verification as LooseRecord, 'run')
    expect(command).toContain('codesign --verify')
    expect(command).toContain('xcrun stapler validate')
  })

  it('keeps manual assembly unsigned and tag assembly finalization-gated', () => {
    const jobs = workflowJobs(releaseWorkflow)
    const build = asRecord(jobs.build, 'build job')
    const upload = jobSteps(build).find(
      (step) => step.name === 'Upload target release input'
    )
    const uploadCondition = stringField(upload as LooseRecord, 'if')
    expect(uploadCondition).toContain("matrix.platform == 'linux'")
    expect(uploadCondition).toContain(
      "github.event_name == 'workflow_dispatch'"
    )

    const assemble = asRecord(jobs.assemble, 'assemble job')
    expect(jobNeeds(assemble)).toContain('sign')
    const condition = stringField(assemble, 'if')
    expect(condition).toContain('always()')
    expect(condition).toContain("needs.sign.result == 'success'")
    expect(condition).toContain("needs.sign.result == 'skipped'")
  })

  it('uses a bounded tar and one exact staged-dependency hook', () => {
    const config = asRecord(
      JSON.parse(signingConfigSource) as unknown,
      'restricted signing config'
    )
    expect(config.extends).toBeNull()
    expect(config.npmRebuild).toBe(true)
    expect(stringField(config, 'beforeBuild')).toBe(
      './scripts/before-build-use-staged-dependencies.mjs'
    )
    expect(
      stringField(asRecord(config.directories, 'signing directories'), 'app')
    ).toBe('dist/electron-app')
    expect(stringField(config, 'electronDist')).toBe('trusted/electron.zip')
    expect(stringField(config, 'electronVersion')).toBe('43.4.0')
    expect(signingInputSource).toContain(
      "config.directories?.app !== 'dist/electron-app'"
    )
    for (const hook of [
      'afterAllArtifactBuild',
      'afterExtract',
      'afterPack',
      'afterSign',
      'beforePack',
      'onNodeModuleFile',
    ]) {
      expect(config).not.toHaveProperty(hook)
    }

    const tool = asRecord(
      JSON.parse(signingToolPackageSource) as unknown,
      'signing tool package'
    )
    expect(tool).not.toHaveProperty('scripts')
    expect(
      stringField(
        asRecord(tool.dependencies, 'signing tool dependencies'),
        'electron-builder'
      )
    ).toBe('26.15.7')
    const lock = asRecord(
      JSON.parse(signingToolLockSource) as unknown,
      'signing tool lock'
    )
    expect(lock.lockfileVersion).toBe(3)

    const sign = asRecord(workflowJobs(releaseWorkflow).sign, 'sign job')
    const extraction = jobSteps(sign).find(
      (step) => step.name === 'Safely extract bounded signing input'
    )
    const source = stringField(extraction as LooseRecord, 'run')
    expect(source).toContain('archiveBytes')
    expect(source).toContain('inputBytes')
    expect(source).toContain('fileBytes')
    expect(source).toContain('fileCount')
    expect(source).toContain('tar requires two zero end blocks')
    expect(source).toContain('tar contains trailing bytes')
    expect(source).toContain('unsupported tar entry type')

    const verification = jobSteps(sign).find(
      (step) => step.name === 'Verify signing input before secrets'
    )
    const verifierEnvironment = asRecord(
      verification?.env,
      'signing input verifier environment'
    )
    expect(stringField(verifierEnvironment, 'VERIFIER_SHA256')).toBe(
      createHash('sha256').update(signingInputSource).digest('hex')
    )
  })

  it('keeps the signing Electron runtime aligned with project metadata', () => {
    const metadata = asRecord(
      JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')),
      'package metadata'
    )
    const version = stringField(
      asRecord(metadata.devDependencies, 'dev dependencies'),
      'electron'
    )
    expect(version).toBe('43.4.0')
    expect(
      stringField(
        asRecord(
          JSON.parse(signingConfigSource) as unknown,
          'restricted signing config'
        ),
        'electronVersion'
      )
    ).toBe(version)
    expect(signingInputSource).toContain(
      `const ELECTRON_VERSION = '${version}'`
    )
    expect(releaseSource).toContain(`/electron/releases/download/v${version}/`)
  })

  it('keeps inline Node workflow steps syntactically executable', () => {
    let checked = 0
    for (const [jobName, value] of Object.entries(
      workflowJobs(releaseWorkflow)
    )) {
      for (const step of jobSteps(asRecord(value, `${jobName} job`))) {
        if (step.shell !== 'node {0}') continue
        const source = stringField(step, 'run').replace(
          /\$\{\{[\s\S]*?\}\}/gu,
          'github_expression'
        )
        expect(
          () => new Script(source, { filename: `${jobName}.js` })
        ).not.toThrow()
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
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

  it('assigns an increasing numeric macOS bundle build to unsigned and signed packages', () => {
    const bundleVersionArgument = `-c.mac.bundleVersion=\${{ github.run_number }}.\${{ github.run_attempt }}.0`

    const jobs = workflowJobs(releaseWorkflow)
    const buildMac = jobSteps(asRecord(jobs.build, 'build job')).find(
      (step) => step.name === 'Electron Builder (macOS)'
    )
    const signMac = jobSteps(asRecord(jobs.sign, 'sign job')).find(
      (step) => step.name === 'Electron Builder (macOS signing boundary)'
    )

    expect(buildMac).toBeDefined()
    expect(signMac).toBeDefined()
    expect(stringField(buildMac as LooseRecord, 'run')).toContain(
      bundleVersionArgument
    )
    expect(stringField(signMac as LooseRecord, 'run')).toContain(
      bundleVersionArgument
    )
  })
})

describe('workflow shell portability contract', () => {
  it('recognizes Bash environment syntax without flagging shell-neutral forms', () => {
    expect(bareUppercaseEnvironmentReferences('$GITHUB_SHA')).toEqual([
      '$GITHUB_SHA',
    ])
    expect(bareUppercaseEnvironmentReferences(`\${GITHUB_SHA}`)).toEqual([
      `\${GITHUB_SHA}`,
    ])
    expect(bareUppercaseEnvironmentReferences(`\${FOO:-default}`)).toEqual([
      `\${FOO:-default}`,
    ])
    expect(bareUppercaseEnvironmentReferences(`\${{ github.sha }}`)).toEqual([])
    expect(bareUppercaseEnvironmentReferences('$env:GITHUB_SHA')).toEqual([])
    expect(bareUppercaseEnvironmentReferences('$Env:GITHUB_SHA')).toEqual([])
  })

  it.each([
    ['', true],
    ["matrix.platform == 'linux'", false],
    ['matrix.platform == "darwin"', false],
    ["matrix.os == 'ubuntu-22.04'", false],
    ['matrix.os == "macos-26-intel"', false],
    ["matrix.platform == 'win32'", true],
    ["matrix.os != 'win32'", true],
    ["github.event_name == 'push' && matrix.platform == 'linux'", true],
  ] as const)(
    'treats %j as Windows-capable only when it is not an explicit non-Windows equality',
    (condition, expected) => {
      expect(stepMayRunOnWindows({ if: condition })).toBe(expected)
    }
  )

  it('rejects bare environment variables in release Windows default-shell steps', () => {
    const violations: string[] = []
    const jobs = workflowJobs(releaseWorkflow)
    const workflowShell = defaultRunShell(releaseWorkflow)

    for (const jobName of ['build', 'sign'] as const) {
      const job = asRecord(jobs[jobName], `${jobName} job`)
      expect(
        matrixEntries(job, jobName).some(
          (entry) =>
            stringField(entry, 'platform') === 'win32' &&
            stringField(entry, 'os').startsWith('windows-')
        ),
        `${jobName} must retain a Windows matrix target`
      ).toBe(true)
      const jobShell = defaultRunShell(job) ?? workflowShell

      for (const step of jobSteps(job)) {
        if (
          typeof step.run !== 'string' ||
          step.shell !== undefined ||
          jobShell !== undefined ||
          !stepMayRunOnWindows(step)
        ) {
          continue
        }
        const references = bareUppercaseEnvironmentReferences(step.run)
        if (references.length === 0) continue
        violations.push(
          `release.yml:${jobName}:${stringField(step, 'name', '<unnamed>')}: ${references.join(', ')}`
        )
      }
    }

    expect(violations).toEqual([])
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
    expect(
      dockerfile.match(new RegExp(`corepack prepare pnpm@${PNPM_VERSION}`, 'g'))
    ).toHaveLength(2)
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
            typeof entry.platform === 'string' &&
            typeof entry.arch === 'string' &&
            typeof entry.rust_target === 'string'
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

function matrixEntries(job: LooseRecord, label: string): LooseRecord[] {
  const strategy = asRecord(job.strategy, `${label} strategy`)
  const matrix = asRecord(strategy.matrix, `${label} matrix`)
  if (!Array.isArray(matrix.include)) {
    throw new TypeError(`${label} matrix include must be an array`)
  }
  return matrix.include.map((entry) => asRecord(entry, `${label} matrix entry`))
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

function bareUppercaseEnvironmentReferences(command: string): string[] {
  return Array.from(
    command.matchAll(
      /\$(?!\{\{|[Ee][Nn][Vv]:)(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*(?::-[^}]*)?\})/gu
    ),
    (match) => match[0]
  )
}

function defaultRunShell(record: LooseRecord): string | undefined {
  if (record.defaults === undefined) return undefined
  const defaults = asRecord(record.defaults, 'workflow defaults')
  if (defaults.run === undefined) return undefined
  const run = asRecord(defaults.run, 'workflow run defaults')
  return typeof run.shell === 'string' ? run.shell : undefined
}

function stepMayRunOnWindows(step: LooseRecord): boolean {
  const condition = stringField(step, 'if', '').trim()
  if (/^matrix\.platform\s*==\s*(['"])(?:darwin|linux)\1$/u.test(condition)) {
    return false
  }
  if (/^matrix\.os\s*==\s*(['"])(?:macos|ubuntu)[^'"]*\1$/u.test(condition)) {
    return false
  }
  return true
}
