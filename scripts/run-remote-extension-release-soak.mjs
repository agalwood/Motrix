import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, release } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseRemoteExtensionSoakRepeats } from './run-remote-extension-soak.mjs'
import { verifyRemoteExtensionCompatibility } from './verify-remote-extension-compatibility.mjs'

const RELEASE_REPEATS = 20
const DEFAULT_MANIFEST = 'e2e/bridge/remote-extension-compatibility.json'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`
    )
  }
  return String(result.stdout ?? '').trim()
}

function git(repository, args) {
  return run('git', ['-C', repository, ...args])
}

function normalizeRepoPath(value) {
  return value.split(sep).join('/')
}

function listFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`release build contains unsupported entry: ${path}`)
  }
  return files.sort((a, b) => a.localeCompare(b))
}

export function digestDirectory(directory) {
  const root = resolve(directory)
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`release build must not be a symbolic link: ${root}`)
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`release build is not a directory: ${root}`)
  }
  const hash = createHash('sha256')
  for (const path of listFiles(root)) {
    hash.update(normalizeRepoPath(relative(root, path)))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function validateReleaseSoakState(input) {
  if (input.repeats !== RELEASE_REPEATS) {
    throw new Error(
      `release soak requires exactly ${RELEASE_REPEATS} repetitions`
    )
  }
  if (input.extensionDirty || input.motrixDirty) {
    throw new Error(
      'release soak requires clean Extension and Motrix worktrees'
    )
  }
  if (input.extensionHead !== input.extensionPin) {
    throw new Error('Extension HEAD must exactly match the compatibility pin')
  }
  if (input.manifestRelativePath !== DEFAULT_MANIFEST) {
    throw new Error(`release manifest must be ${DEFAULT_MANIFEST}`)
  }
  if (
    input.motrixChangedFiles.length !== 1 ||
    input.motrixChangedFiles[0] !== input.manifestRelativePath
  ) {
    throw new Error(
      'Motrix changes after its compatibility pin must contain only the pinned manifest'
    )
  }
  return input
}

function inferExtensionRepository(env) {
  if (env.MOTRIX_EXTENSION_REPO)
    return realpathSync(resolve(env.MOTRIX_EXTENSION_REPO))
  if (env.MOTRIX_EXTENSION_BUILD) {
    return realpathSync(resolve(env.MOTRIX_EXTENSION_BUILD, '../../../..'))
  }
  throw new Error('MOTRIX_EXTENSION_REPO or MOTRIX_EXTENSION_BUILD is required')
}

export function validateReleaseManifestLocation(input) {
  if (input.relativePath !== DEFAULT_MANIFEST) {
    throw new Error(`release manifest must be ${DEFAULT_MANIFEST}`)
  }
  if (!input.isFile || input.isSymbolicLink) {
    throw new Error('release manifest must be a regular non-symlink file')
  }
  return input.relativePath
}

export function validateReleaseBuildLocation(input) {
  if (input.isSymbolicLink || input.actualPath !== input.expectedPath) {
    throw new Error(
      `${input.kind} build must be inside the pinned Extension checkout and must not be a symbolic link`
    )
  }
  return input.actualPath
}

function expectedBuildDirectory(extensionRepository, kind, configured) {
  if (!configured) {
    throw new Error(
      `MOTRIX_${kind === 'chromium' ? '' : 'FIREFOX_'}EXTENSION_BUILD is required in release mode`
    )
  }
  const expected = join(extensionRepository, 'packages/ext/dist', kind)
  const actual = resolve(configured)
  const isSymbolicLink = lstatSync(actual).isSymbolicLink()
  validateReleaseBuildLocation({
    kind,
    actualPath: isSymbolicLink ? actual : realpathSync(actual),
    expectedPath: realpathSync(expected),
    isSymbolicLink,
  })
  return actual
}

export function buildReleaseExtensions(env = process.env, spawn = spawnSync) {
  const extensionRepository = inferExtensionRepository(env)
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  for (const target of ['build:chromium', 'build:firefox']) {
    const result = spawn(
      executable,
      ['--dir', extensionRepository, '--filter', '@motrix/extension', target],
      { stdio: 'inherit', env }
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(
        `release Extension ${target} failed with exit code ${String(result.status)}`
      )
    }
  }
}

function executableVersion(path, label) {
  if (!path)
    throw new Error(`${label} executable must be explicit in release mode`)
  if (!existsSync(path))
    throw new Error(`${label} executable does not exist: ${path}`)
  return run(path, ['--version'])
}

export function collectReleaseSoakContext(
  env = process.env,
  { includeBuilds = true } = {}
) {
  const motrixRepository = resolve(process.cwd())
  const extensionRepository = inferExtensionRepository(env)
  const manifestPath = resolve(
    motrixRepository,
    env.MOTRIX_REMOTE_EXTENSION_COMPATIBILITY_MANIFEST ?? DEFAULT_MANIFEST
  )
  const manifestRelativePath = normalizeRepoPath(
    relative(motrixRepository, manifestPath)
  )
  const manifestStat = lstatSync(manifestPath)
  validateReleaseManifestLocation({
    relativePath: manifestRelativePath,
    isFile: manifestStat.isFile(),
    isSymbolicLink: manifestStat.isSymbolicLink(),
  })
  const manifest = verifyRemoteExtensionCompatibility({
    manifestPath,
    motrixRepository,
    extensionRepository,
  })
  const extensionHead = git(extensionRepository, ['rev-parse', 'HEAD'])
  const motrixHead = git(motrixRepository, ['rev-parse', 'HEAD'])
  const extensionDirty =
    git(extensionRepository, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]).length > 0
  const motrixDirty =
    git(motrixRepository, ['status', '--porcelain', '--untracked-files=normal'])
      .length > 0
  const changed = git(motrixRepository, [
    'diff',
    '--name-only',
    `${manifest.motrix.commit}..HEAD`,
  ])
  const motrixChangedFiles = changed === '' ? [] : changed.split('\n').sort()
  validateReleaseSoakState({
    repeats: RELEASE_REPEATS,
    extensionDirty,
    motrixDirty,
    extensionHead,
    extensionPin: manifest.extension.commit,
    motrixChangedFiles,
    manifestRelativePath,
  })

  const builds = includeBuilds
    ? (() => {
        const chromiumBuild = expectedBuildDirectory(
          extensionRepository,
          'chromium',
          env.MOTRIX_EXTENSION_BUILD
        )
        const firefoxBuild = expectedBuildDirectory(
          extensionRepository,
          'firefox',
          env.MOTRIX_FIREFOX_EXTENSION_BUILD
        )
        return {
          chromium: {
            path: chromiumBuild,
            sha256: digestDirectory(chromiumBuild),
          },
          firefox: {
            path: firefoxBuild,
            sha256: digestDirectory(firefoxBuild),
          },
        }
      })()
    : null
  return {
    protocol: manifest.protocol,
    compatibilityManifest: manifestRelativePath,
    pins: {
      extension: manifest.extension.commit,
      motrix: manifest.motrix.commit,
    },
    heads: { extension: extensionHead, motrix: motrixHead },
    repositories: { extension: extensionRepository, motrix: motrixRepository },
    builds,
    browsers: {
      chromium: executableVersion(env.MOTRIX_CHROMIUM_EXECUTABLE, 'Chromium'),
      firefox: executableVersion(env.MOTRIX_FIREFOX_EXECUTABLE, 'Firefox'),
    },
    operatingSystem: { platform: platform(), release: release(), arch: arch() },
    faultInjection: env.MOTRIX_REMOTE_EXTENSION_SOAK_FAULTS ?? 'none',
  }
}

function defaultWriteEvidence(directory, evidence) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'evidence.json')
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return path
}

function defaultPrepareEvidenceDirectory(directory) {
  mkdirSync(dirname(directory), { recursive: true })
  // Deliberately omit `recursive`: an existing run directory must fail rather
  // than allowing Playwright's JSON reporter to overwrite prior evidence.
  mkdirSync(directory)
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

export function validateReleasePlaywrightReport(
  input,
  expectedBrowserCases = RELEASE_REPEATS * 5
) {
  const report = assertObject(input, 'Playwright report')
  if (!Array.isArray(report.errors) || report.errors.length !== 0) {
    throw new Error('Playwright report contains top-level errors')
  }
  if (!Array.isArray(report.suites)) {
    throw new Error('Playwright report suites must be an array')
  }
  const summary = {
    testEntries: 0,
    browserCases: 0,
    passed: 0,
    failed: 0,
  }
  const visitSuite = (value) => {
    const suite = assertObject(value, 'Playwright suite')
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) {
        throw new Error('Playwright suite specs must be an array')
      }
      for (const specValue of suite.specs) {
        const spec = assertObject(specValue, 'Playwright spec')
        if (!Array.isArray(spec.tests)) {
          throw new Error('Playwright spec tests must be an array')
        }
        for (const testValue of spec.tests) {
          const test = assertObject(testValue, 'Playwright test')
          summary.testEntries += 1
          if (
            test.expectedStatus !== 'passed' ||
            test.status !== 'expected' ||
            !Array.isArray(test.results) ||
            test.results.length === 0
          ) {
            summary.failed += 1
            continue
          }
          for (const resultValue of test.results) {
            const result = assertObject(resultValue, 'Playwright result')
            summary.browserCases += 1
            if (
              result.status === 'passed' &&
              Array.isArray(result.errors) &&
              result.errors.length === 0
            ) {
              summary.passed += 1
            } else {
              summary.failed += 1
            }
          }
        }
      }
    }
    if (suite.suites !== undefined) {
      if (!Array.isArray(suite.suites)) {
        throw new Error('Playwright nested suites must be an array')
      }
      for (const nested of suite.suites) visitSuite(nested)
    }
  }
  for (const suite of report.suites) visitSuite(suite)
  if (
    summary.browserCases !== expectedBrowserCases ||
    summary.passed !== expectedBrowserCases ||
    summary.failed !== 0
  ) {
    throw new Error(
      `Playwright report must contain exactly ${expectedBrowserCases} passed browser cases; got ${JSON.stringify(summary)}`
    )
  }
  return summary
}

function defaultValidateReport(path) {
  return validateReleasePlaywrightReport(JSON.parse(readFileSync(path, 'utf8')))
}

export function runRemoteExtensionReleaseSoak({
  env = process.env,
  spawn = spawnSync,
  context,
  prepareBuild = buildReleaseExtensions,
  collectContext = collectReleaseSoakContext,
  now = () => new Date(),
  writeEvidence = defaultWriteEvidence,
  reportExists = existsSync,
  validateReport = defaultValidateReport,
  prepareEvidenceDirectory = defaultPrepareEvidenceDirectory,
} = {}) {
  let releaseContext = context
  if (releaseContext === undefined) {
    // First collection is a clean/pinned source preflight. Build both browser
    // artifacts from that exact checkout, then collect again so recorded
    // digests describe the newly produced output and any tracked build side
    // effect fails the second clean-worktree check.
    collectContext(env, { includeBuilds: false })
    prepareBuild(env)
    releaseContext = collectContext(env, { includeBuilds: true })
  }
  const repeats = parseRemoteExtensionSoakRepeats(
    env.MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS
  )
  validateReleaseSoakState({
    repeats,
    extensionDirty: false,
    motrixDirty: false,
    extensionHead: releaseContext.heads.extension,
    extensionPin: releaseContext.pins.extension,
    motrixChangedFiles: [releaseContext.compatibilityManifest],
    manifestRelativePath: releaseContext.compatibilityManifest,
  })
  const started = now()
  const runId = started.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const evidenceDirectory = resolve(
    env.MOTRIX_REMOTE_EXTENSION_SOAK_EVIDENCE_DIR ??
      join('e2e/test-results/remote-extension-soak', runId)
  )
  prepareEvidenceDirectory(evidenceDirectory)
  const reportPath = join(evidenceDirectory, 'playwright-report.json')
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawn(executable, ['test:e2e:remote-extension:soak'], {
    stdio: 'inherit',
    env: {
      ...env,
      MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS: String(RELEASE_REPEATS),
      MOTRIX_REMOTE_EXTENSION_EVIDENCE_DIR: evidenceDirectory,
    },
  })
  const ended = now()
  const reportPresent = reportExists(reportPath)
  let reportSummary = null
  let reportValidationError = null
  if (result.status === 0 && reportPresent) {
    try {
      reportSummary = validateReport(reportPath)
    } catch (error) {
      reportValidationError =
        error instanceof Error ? error.message : String(error)
    }
  }
  const status = result.error
    ? 'spawn-error'
    : result.status !== 0
      ? 'failed'
      : reportPresent && reportValidationError === null
        ? 'passed'
        : 'incomplete'
  const evidence = {
    schemaVersion: 1,
    protocol: 'MDXP-over-MBP1',
    status,
    repeats: RELEASE_REPEATS,
    browserCases: RELEASE_REPEATS * 5,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: ended.getTime() - started.getTime(),
    context: releaseContext,
    artifacts: {
      playwrightReport: reportPath,
      reportPresent,
      reportSummary,
      reportValidationError,
    },
  }
  const evidencePath = writeEvidence(evidenceDirectory, evidence)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `remote Extension release soak failed with exit code ${String(result.status)}; evidence: ${evidencePath}`
    )
  }
  if (!reportPresent) {
    throw new Error(`Playwright JSON report missing: ${reportPath}`)
  }
  if (reportValidationError !== null) {
    throw new Error(`Playwright JSON report invalid: ${reportValidationError}`)
  }
  return { evidencePath, reportPath, evidence }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runRemoteExtensionReleaseSoak()
    console.log(
      `Remote Extension release soak evidence: ${result.evidencePath}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
