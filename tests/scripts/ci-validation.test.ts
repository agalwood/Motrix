import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- CI script has no declaration file
import {
  ALWAYS_REQUIRED,
  CONDITIONAL_JOBS,
  validateCiResults,
} from '../../scripts/ci-gate.mjs'
// @ts-expect-error -- CI script has no declaration file
import {
  changedFiles,
  createCiPlan,
  PACKAGE_TARGETS,
} from '../../scripts/ci-plan.mjs'
// @ts-expect-error -- CI script has no declaration file
import {
  NATIVE_FIXTURE_SUITES,
  verifyNativeFixtures,
  verifyTestReports,
} from '../../scripts/verify-ci-test-reports.mjs'

const require = createRequire(import.meta.url)
const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as any
const uiFiles = [
  'src/renderer/routes/downloads/task-list.tsx',
  'src/shared/locales/zh-CN.json',
]

describe('CI scope selection', () => {
  it('keeps companion unit tests in the complete root suite without expanding a UI matrix', () => {
    expect(
      createCiPlan('pull_request', [
        ...uiFiles,
        'src/core/plugin/commands/wire.test.ts',
      ])
    ).toMatchObject({ profile: 'ui', filesystems: false })
    expect(
      createCiPlan('pull_request', ['src/core/plugin/commands/wire.test.ts'])
        .profile
    ).toBe('full')
    for (const file of [
      'src/core/engine/aria2/engine.integration.test.ts',
      'src/core/plugin/finalize/finalize.test.ts',
      'src/main/os.win32.test.ts',
    ]) {
      expect(createCiPlan('pull_request', [...uiFiles, file]).profile).toBe(
        'full'
      )
    }
  })
  it('keeps three native OS targets for presentation-only PRs', () => {
    const plan = createCiPlan('pull_request', uiFiles)
    expect(plan).toMatchObject({
      profile: 'ui',
      distributions: false,
      installers: false,
      filesystems: false,
    })
    expect(
      plan.package_matrix.include.map((entry: any) => entry.target).sort()
    ).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64'])
  })

  it.each([
    'src/renderer/lib/transport.ts',
    'src/preload/index.ts',
    'src/core/task/task-manager.ts',
    'src/server/index.ts',
    'src/shared/protocol/commands.ts',
    'src/main/index.ts',
    'packages/native-host/src/main.rs',
    'packages/finalize-fs/src/main.rs',
    'packages/safari-bootstrap/Native/NativeBootstrapResolver.swift',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'electron-builder.json',
    '.cargo/config.toml',
    'Dockerfile',
    'flatpak/app.motrix.native.yml',
    'build/snap/snapcraft.yaml',
    '.github/workflows/ci.yml',
    '.github/ci-package-targets.json',
    'scripts/ci-plan.mjs',
    'tests/scripts/ci-validation.test.ts',
    'new-unknown-input',
    'src/renderer/components/unusual\nname.tsx',
  ])('uses the complete matrix for %s, including mixed UI PRs', (file) => {
    const plan = createCiPlan('pull_request', [...uiFiles, file])
    expect(plan).toMatchObject({
      profile: 'full',
      distributions: true,
      installers: true,
    })
    expect(plan.package_matrix.include).toEqual(PACKAGE_TARGETS)
    expect(plan.package_matrix.include).toHaveLength(6)
  })

  it.each(['push', 'schedule', 'workflow_dispatch', 'merge_group', 'unknown'])(
    'keeps full validation for %s events',
    (event) => {
      expect(createCiPlan(event, uiFiles).profile).toBe('full')
    }
  )

  it.each([undefined, []])(
    'falls back to full validation when comparison is unavailable',
    (files) => {
      expect(createCiPlan('pull_request', files)).toMatchObject({
        profile: 'full',
        filesystems: true,
      })
    }
  )

  it.each([
    'packages/finalize-fs/src/main.rs',
    'src/core/task/task-recovery-service.ts',
    'pnpm-lock.yaml',
    'scripts/ci-plan.mjs',
  ])('includes actual filesystem tests for %s', (file) => {
    expect(createCiPlan('pull_request', [file]).filesystems).toBe(true)
  })

  it('uses a merge-base diff, preserves deleted rename sources and has no API file limit', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'motrix-ci-diff-'))
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const put = (file: string) => {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
      writeFileSync(path.join(cwd, file), file)
    }
    const commit = () => {
      git('add', '.')
      git('commit', '-m', 'fixture')
      return git('rev-parse', 'HEAD')
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'test@example.invalid')
      git('config', 'user.name', 'Test')
      git('config', 'core.fsmonitor', 'false')
      git('config', 'gc.auto', '0')
      git('config', 'maintenance.auto', 'false')
      put('src/core/old.ts')
      commit()
      git('checkout', '-b', 'feature')
      mkdirSync(path.join(cwd, 'src/renderer/components'), { recursive: true })
      git('mv', 'src/core/old.ts', 'src/renderer/components/moved.ts')
      for (let index = 0; index < 3100; index++)
        put(`src/renderer/components/${index}.tsx`)
      put('src/renderer/components/space name.tsx')
      const head = commit()
      git('checkout', 'main')
      put('unrelated-main-change')
      const base = commit()
      const files = changedFiles(
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        cwd
      )
      expect(files).toHaveLength(3103)
      expect(files).toContain('src/core/old.ts')
      expect(files).toContain('src/renderer/components/moved.ts')
      expect(files).toContain('src/renderer/components/space name.tsx')
      expect(files).not.toContain('unrelated-main-change')
      expect(createCiPlan('pull_request', files).profile).toBe('full')
      expect(
        changedFiles('push', { before: head, after: base }, cwd)
      ).toContain('unrelated-main-change')
      expect(() =>
        changedFiles(
          'pull_request',
          { pull_request: { base: { sha: '--help' }, head: { sha: head } } },
          cwd
        )
      ).toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 15_000)
})

function successfulNeeds(profile: 'ui' | 'full') {
  const outputs = {
    profile,
    distributions: String(profile === 'full'),
    filesystems: String(profile === 'full'),
  }
  const needs: Record<string, any> = Object.fromEntries(
    ALWAYS_REQUIRED.map((name: string) => [name, { result: 'success' }])
  )
  needs.plan.outputs = outputs
  for (const [name, flag] of Object.entries(CONDITIONAL_JOBS)) {
    needs[name] = {
      result:
        outputs[flag as keyof typeof outputs] === 'true'
          ? 'success'
          : 'skipped',
    }
  }
  return needs
}

describe('required CI gate', () => {
  it.each(['ui', 'full'] as const)('accepts a complete %s run', (profile) => {
    expect(() => validateCiResults(successfulNeeds(profile))).not.toThrow()
  })

  it.each(['failure', 'cancelled', 'skipped', undefined])(
    'rejects every selected job with result %s',
    (result) => {
      for (const name of [
        ...ALWAYS_REQUIRED,
        ...Object.keys(CONDITIONAL_JOBS),
      ]) {
        const needs = successfulNeeds('full')
        needs[name].result = result
        expect(() => validateCiResults(needs), name).toThrow()
      }
    }
  )

  it('rejects missing jobs, unknown jobs and invalid planning outputs', () => {
    const needs = successfulNeeds('ui')
    delete needs.snap
    expect(() => validateCiResults(needs)).toThrow(/snap/)
    expect(() =>
      validateCiResults({
        ...successfulNeeds('full'),
        extra: { result: 'failure' },
      })
    ).toThrow(/Unaccounted/)
    const invalid = successfulNeeds('full')
    invalid.plan.outputs.distributions = 'false'
    expect(() => validateCiResults(invalid)).toThrow(/plan/)
  })

  it('accounts for every workflow job and runs even after failures', () => {
    const jobs = [...ALWAYS_REQUIRED, ...Object.keys(CONDITIONAL_JOBS)].sort()
    expect(
      Object.keys(workflow.jobs)
        .filter((name) => name !== 'ci')
        .sort()
    ).toEqual(jobs)
    expect([...workflow.jobs.ci.needs].sort()).toEqual(jobs)
    expect(workflow.jobs.ci.name).toBe('ci')
    expect(workflow.jobs.ci.if).toBe(`\${{ always() }}`)
    expect(workflow.on).toHaveProperty('schedule')
    expect(workflow.on).toHaveProperty('merge_group')
    expect(workflow.on.pull_request).not.toHaveProperty('paths')
    expect(workflow.on.pull_request).not.toHaveProperty('paths-ignore')
    for (const [name, flag] of Object.entries(CONDITIONAL_JOBS)) {
      expect(workflow.jobs[name]).toMatchObject({
        needs: 'plan',
        if: `needs.plan.outputs.${flag} == 'true'`,
        uses: `./.github/workflows/${name}.yml`,
      })
      const child = load(
        readFileSync(`.github/workflows/${name}.yml`, 'utf8')
      ) as any
      expect(child.on).toHaveProperty('workflow_call')
      expect(child.on).not.toHaveProperty('pull_request')
    }
  })
})

const report = (names: string[]) => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numTotalTests: names.length,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: names.map((name) => ({ name })),
})
describe('test partition completeness', () => {
  it('rejects native suites that silently skipped because a fixture was missing', () => {
    const reports = [
      {
        testResults: NATIVE_FIXTURE_SUITES.map((file: string) => ({
          name: `/repo/${file}`,
          assertionResults: [{ status: 'passed' }],
        })),
      },
    ]
    expect(() => verifyNativeFixtures(reports)).not.toThrow()
    for (const suite of reports[0]!.testResults) {
      suite.assertionResults[0].status = 'pending'
      expect(() => verifyNativeFixtures(reports)).toThrow(/did not all execute/)
      suite.assertionResults[0].status = 'passed'
    }
    expect(() => verifyNativeFixtures([])).toThrow(/did not all execute/)
  })
  const files = ['a', 'b', 'c', 'd'].map((file) => ({ file }))
  it('accepts the union of all discovered files exactly once', () => {
    expect(
      verifyTestReports(
        files,
        files.map(({ file }) => report([file]))
      )
    ).toEqual({ files: 4, tests: 4, skipped: 0 })
  })
  it('rejects omitted, duplicated, extra and failed test results', () => {
    expect(() => verifyTestReports(files, [report(['a', 'b', 'c'])])).toThrow(
      /Missing/
    )
    expect(() =>
      verifyTestReports(files, [report(['a', 'b', 'c', 'd']), report(['a'])])
    ).toThrow(/Duplicate/)
    expect(() =>
      verifyTestReports(files, [report(['a', 'b', 'c', 'd', 'e'])])
    ).toThrow(/Unexpected/)
    expect(() =>
      verifyTestReports(files, [
        { ...report(['a', 'b', 'c', 'd']), success: false },
      ])
    ).toThrow(/Failed/)
    expect(() => verifyTestReports([], [])).toThrow(/Empty/)
  })
  it('runs four complete partitions with ABI hooks and an independent discovery check', () => {
    const tests = workflow.jobs.tests
    expect(tests.strategy.matrix.shard).toEqual([1, 2, 3, 4])
    expect(tests.strategy['fail-fast']).toBe(false)
    const step = tests.steps.find(
      (step: any) => step.name === 'Run complete test partition'
    )
    expect(step.run).toContain(`pnpm test --shard=\${{ matrix.shard }}/4`)
    expect(step.run).not.toMatch(/--changed|--no-isolate|--passWithNoTests/)
    expect(step.env.MOTRIX_REQUIRE_ELECTRON_PROXY_TEST).toBe('1')
    const fixtureIndex = tests.steps.findIndex(
      (step: any) => step.name === 'Prepare native filesystem test fixture'
    )
    expect(fixtureIndex).toBeGreaterThan(0)
    expect(fixtureIndex).toBeLessThan(tests.steps.indexOf(step))
    expect(tests.steps[fixtureIndex].run).toContain(
      'cargo build --manifest-path packages/finalize-fs/Cargo.toml --locked'
    )
    expect(
      tests.steps.find(
        (step: any) => step.name === 'Upload test partition report'
      ).with.overwrite
    ).toBe(true)
    expect(workflow.jobs['test-reports'].needs).toBe('tests')
    expect(workflow.jobs['torrent-browser']).not.toHaveProperty('needs')
    expect(
      workflow.jobs['torrent-browser'].steps.some((step: any) =>
        step.run?.includes('chromium firefox webkit')
      )
    ).toBe(true)
  })
})

describe('Windows directory smoke', () => {
  it('resolves only the dir target using the real electron-builder CLI parser', () => {
    const {
      configureBuildCommand,
      normalizeOptions,
    } = require('electron-builder/out/builder')
    for (const target of PACKAGE_TARGETS.filter(
      (entry: any) => entry.platform === 'win32'
    )) {
      const args = [
        ...target.electron_builder_args.split(' '),
        '--dir',
        '--publish',
        'never',
      ]
      const parsed = configureBuildCommand(
        require('yargs/yargs')(args)
      ).parseSync()
      const normalized = normalizeOptions(parsed)
      const types = [...normalized.targets.values()]
        .flatMap((arch: any) => [...arch.values()])
        .flat()
      expect(types).toEqual(['dir'])
    }
    const installers = workflow.jobs['package-targets'].steps.find(
      (step: any) => step.name === 'Build Windows installers'
    )
    expect(installers.if).toContain("needs.plan.outputs.installers == 'true'")
    expect(installers.run).toContain('--prepackaged')
  })
})
