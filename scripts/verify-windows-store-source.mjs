import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'

const MAIN_REF = 'refs/remotes/origin/main'
const GIT_OPTIONS = [
  '--no-replace-objects',
  '--no-optional-locks',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.commitGraph=false',
]

function gitEnvironment() {
  // Do not let an inherited index, worktree, object database, or injected Git
  // configuration redirect the checkout being examined. Ignore global/system
  // excludes too: source exclusions must be local to this checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  )
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    // Git for Windows maps /dev/null itself; Node's Windows device path
    // (os.devNull) is not accepted as a Git configuration filename.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  }
}

async function git(repoRoot, args, allowedExitCodes = []) {
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile(
        'git',
        [...GIT_OPTIONS, ...args],
        {
          cwd: repoRoot,
          env: gitEnvironment(),
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            error.stdout = stdout
            reject(error)
          } else {
            resolve(stdout)
          }
        }
      )
    )
    return { stdout, code: 0 }
  } catch (error) {
    if (allowedExitCodes.includes(error.code)) {
      return { stdout: error.stdout ?? '', code: error.code }
    }
    // Do not echo external Git diagnostics, environment values, or file content.
    throw new Error(`Git ${args[0]} failed (exit ${error.code ?? 'unknown'})`)
  }
}

async function exists(filePath) {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Read-only local source checks. A successful result does not bind a supplied
 * payload to this checkout or prove remote protection/freshness. The checkout
 * must remain unchanged while this check and the subsequent build run.
 */
export async function verifyWindowsStoreSource({ repoRoot, metadata: raw }) {
  const report = {
    schemaVersion: 1,
    scope: 'local-git-checkout-only',
    ok: false,
    checks: [],
    observed: {},
    payloadSourceVerified: false,
    protectedTagVerified: false,
    networkFreshnessVerified: false,
  }
  async function check(name, operation) {
    try {
      await operation()
      report.checks.push({ name, ok: true })
      return true
    } catch (error) {
      report.checks.push({ name, ok: false, message: error.message })
      return false
    }
  }

  let metadata
  if (
    !(await check('metadata', () => {
      const validated = validateWindowsStoreMetadata(raw)
      metadata = validated.metadata
      report.metadataValidation = validated.validation
    }))
  ) {
    return report
  }

  let root
  if (
    !(await check('checkout-root', async () => {
      if (typeof repoRoot !== 'string' || !repoRoot) {
        throw new Error('repoRoot must be an explicit checkout directory')
      }
      root = await realpath(repoRoot)
      const { stdout } = await git(root, ['rev-parse', '--show-toplevel'])
      if ((await realpath(stdout.trim())) !== root) {
        throw new Error('repoRoot must be the Git checkout root')
      }
    }))
  ) {
    return report
  }

  if (
    !(await check('git-integrity', async () => {
      const { stdout: replacements } = await git(root, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/replace/',
      ])
      if (replacements.trim())
        throw new Error('Git replace refs are not allowed')
      const { stdout: graftPath } = await git(root, [
        'rev-parse',
        '--git-path',
        'info/grafts',
      ])
      if (await exists(path.resolve(root, graftPath.trim()))) {
        throw new Error('Git graft files are not allowed')
      }
      // Status may invoke clean/process filters when refreshing tracked files.
      // Fail closed instead of executing checkout-supplied external commands.
      const filters = await git(
        root,
        ['config', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
        [1]
      )
      if (filters.stdout.trim()) {
        throw new Error('External Git clean/process filters are not allowed')
      }
      const { stdout: files } = await git(root, ['ls-files', '-v', '-z'])
      if (files.split('\0').some((entry) => /^[a-zS]/.test(entry))) {
        throw new Error(
          'Assume-unchanged and skip-worktree index entries are not allowed'
        )
      }
      // This project has no submodules. Reject gitlinks rather than allowing
      // recursive status to execute a submodule's own clean/process filters.
      const { stdout: entries } = await git(root, ['ls-files', '--stage', '-z'])
      if (entries.split('\0').some((entry) => entry.startsWith('160000 '))) {
        throw new Error(
          'Submodule checkouts are not supported by this source verifier'
        )
      }
    }))
  ) {
    return report
  }

  await check('head', async () => {
    const { stdout } = await git(root, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ])
    report.observed.commit = stdout.trim()
    if (report.observed.commit !== metadata.source.commit) {
      throw new Error('HEAD does not match source.commit')
    }
  })
  await check('package-version', async () => {
    const value = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8')
    )
    report.observed.productVersion = value.version
    if (value.version !== metadata.productVersion) {
      throw new Error('package.json version does not match productVersion')
    }
  })
  await check('clean-worktree', async () => {
    const { stdout } = await git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ])
    if (stdout.length !== 0) {
      throw new Error(
        'Checkout has tracked, staged, untracked, or submodule changes'
      )
    }
  })

  if (metadata.source.tag !== undefined) {
    await check('source-tag', async () => {
      const ref = `refs/tags/${metadata.source.tag}`
      await git(root, ['check-ref-format', ref])
      const { stdout } = await git(root, [
        'rev-parse',
        '--verify',
        `${ref}^{commit}`,
      ])
      report.observed.tagCommit = stdout.trim()
      if (report.observed.tagCommit !== metadata.source.commit) {
        throw new Error('The exact source.tag ref does not match source.commit')
      }
    })
  }

  if (metadata.profile === 'store') {
    await check('origin-main-ancestry', async () => {
      const { stdout } = await git(root, [
        'rev-parse',
        '--verify',
        `${MAIN_REF}^{commit}`,
      ])
      report.observed.originMainCommit = stdout.trim()
      const result = await git(
        root,
        [
          'merge-base',
          '--is-ancestor',
          metadata.source.commit,
          report.observed.originMainCommit,
        ],
        [1]
      )
      if (result.code !== 0) {
        throw new Error(
          'source.commit is not an ancestor of local refs/remotes/origin/main'
        )
      }
    })
  }

  report.ok = report.checks.every((item) => item.ok)
  return report
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key !== '--metadata' && key !== '--repo-root') {
      throw new Error(`Unknown argument: ${key}`)
    }
    if (Object.hasOwn(options, key))
      throw new Error(`Duplicate argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`${key} requires a value`)
    options[key] = value
  }
  if (!options['--metadata'] || !options['--repo-root']) {
    throw new Error(
      'Required arguments: --metadata <file> --repo-root <checkout>'
    )
  }
  return options
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const metadata = JSON.parse(await readFile(options['--metadata'], 'utf8'))
    const report = await verifyWindowsStoreSource({
      repoRoot: options['--repo-root'],
      metadata,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          checks: [{ name: 'input', ok: false, message: error.message }],
          payloadSourceVerified: false,
          protectedTagVerified: false,
          networkFreshnessVerified: false,
        },
        null,
        2
      )}\n`
    )
    process.exitCode = 1
  }
}
