// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { verifyWindowsStoreSource } from '../../scripts/verify-windows-store-source.mjs'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const script = path.resolve('scripts/verify-windows-store-source.mjs')
const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function fixture(version = '2.0.0') {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-store-source-'))
  roots.push(root)
  git(root, 'init', '--template=', '--initial-branch=main')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'Source verifier fixture')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n')
  await writeFile(path.join(root, 'source.js'), 'export const value = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'fixture')
  const commit = git(root, 'rev-parse', 'HEAD')
  git(root, 'tag', '-a', `v${version}`, '-m', 'fixture tag')
  git(root, 'update-ref', 'refs/remotes/origin/main', commit)
  git(
    root,
    'remote',
    'add',
    'origin',
    'https://network-must-not-be-used.invalid/repo.git'
  )
  return { root, commit }
}

function metadata(commit: string) {
  return {
    schemaVersion: 1,
    profile: 'store',
    architecture: 'x64',
    productVersion: '2.0.0',
    packageVersion: '2.0.0.0',
    source: { commit, tag: 'v2.0.0' },
    identity: {
      name: 'Example.Motrix',
      publisher: 'CN=Example Publisher',
      publisherDisplayName: 'Example Publisher',
    },
  }
}

function failed(
  report: { ok: boolean; checks: { name: string; ok: boolean }[] },
  name: string
) {
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(
    expect.objectContaining({ name, ok: false })
  )
}

beforeEach(() => {
  vi.mocked(execFile).mockClear()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store local source verification', () => {
  it('accepts a clean annotated stable tag without claiming payload or remote provenance', async () => {
    const { root, commit } = await fixture()
    await mkdir(path.join(root, 'ignored'))
    await writeFile(path.join(root, 'ignored', 'build.bin'), 'ignored output')
    const indexBefore = await readFile(path.join(root, '.git', 'index'))
    const refsBefore = git(root, 'show-ref')
    const report = await verifyWindowsStoreSource({
      repoRoot: root,
      metadata: metadata(commit),
    })
    expect(report).toMatchObject({
      ok: true,
      scope: 'local-git-checkout-only',
      observed: {
        commit,
        tagCommit: commit,
        originMainCommit: commit,
        productVersion: '2.0.0',
      },
      payloadSourceVerified: false,
      protectedTagVerified: false,
      networkFreshnessVerified: false,
    })
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(
      indexBefore
    )
    expect(git(root, 'show-ref')).toBe(refsBefore)

    // Inspect the actual calls while still executing real Git in the fixture.
    expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0)
    for (const [command, args, options] of vi.mocked(execFile).mock.calls) {
      expect(command).toBe('git')
      expect(args).toEqual(
        expect.arrayContaining([
          '--no-replace-objects',
          '--no-optional-locks',
          'protocol.allow=never',
        ])
      )
      expect(args).not.toEqual(expect.arrayContaining(['fetch']))
      expect(args).not.toEqual(expect.arrayContaining(['pull']))
      expect(args).not.toEqual(expect.arrayContaining(['ls-remote']))
      expect(options).toMatchObject({
        shell: false,
        env: {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      })
    }
  })

  it('accepts a stable source commit older than local origin/main', async () => {
    const { root, commit } = await fixture()
    git(root, 'commit', '--allow-empty', '-m', 'next')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'checkout', '--detach', commit)
    expect(
      (
        await verifyWindowsStoreSource({
          repoRoot: root,
          metadata: metadata(commit),
        })
      ).ok
    ).toBe(true)
  })

  it('accepts a linked worktree using the common repository refs', async () => {
    const { root, commit } = await fixture()
    const worktree = await mkdtemp(
      path.join(tmpdir(), 'motrix-source-worktree-')
    )
    roots.push(worktree)
    git(root, 'worktree', 'add', '--detach', worktree, commit)
    expect(
      (
        await verifyWindowsStoreSource({
          repoRoot: worktree,
          metadata: metadata(commit),
        })
      ).ok
    ).toBe(true)
  })

  it('permits an untagged beta test profile without origin/main', async () => {
    const { root, commit } = await fixture('2.0.0-beta.41')
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main')
    const input = {
      ...metadata(commit),
      profile: 'test',
      productVersion: '2.0.0-beta.41',
      source: { commit },
      identity: {
        name: 'Motrix.Store.Test',
        publisher: 'CN=Motrix Store Test',
        publisherDisplayName: 'Motrix Store Test',
      },
    }
    expect(
      (await verifyWindowsStoreSource({ repoRoot: root, metadata: input })).ok
    ).toBe(true)
  })

  it('rejects invalid metadata before invoking Git', async () => {
    failed(
      await verifyWindowsStoreSource({
        repoRoot: '/not-used',
        metadata: metadata('abc'),
      }),
      'metadata'
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('requires the supplied directory itself to be the checkout root', async () => {
    const { root, commit } = await fixture()
    const nested = path.join(root, 'ignored')
    await mkdir(nested)
    failed(
      await verifyWindowsStoreSource({
        repoRoot: nested,
        metadata: metadata(commit),
      }),
      'checkout-root'
    )
  })

  it('rejects a clean checkout whose package version differs', async () => {
    const { root, commit } = await fixture('2.1.0')
    failed(
      await verifyWindowsStoreSource({
        repoRoot: root,
        metadata: metadata(commit),
      }),
      'package-version'
    )
  })

  it('rejects HEAD differing from the supplied full commit', async () => {
    const { root, commit } = await fixture()
    git(root, 'commit', '--allow-empty', '-m', 'different HEAD')
    failed(
      await verifyWindowsStoreSource({
        repoRoot: root,
        metadata: metadata(commit),
      }),
      'head'
    )
  })

  it.each(['missing', 'mismatched', 'branch-only'])(
    'rejects a %s exact tag ref',
    async (mode) => {
      const { root, commit } = await fixture()
      git(root, 'tag', '-d', 'v2.0.0')
      if (mode === 'mismatched') {
        git(root, 'commit', '--allow-empty', '-m', 'other tag target')
        git(root, 'tag', 'v2.0.0')
        git(root, 'checkout', '--detach', commit)
      } else if (mode === 'branch-only') {
        git(root, 'branch', 'v2.0.0')
      }
      failed(
        await verifyWindowsStoreSource({
          repoRoot: root,
          metadata: metadata(commit),
        }),
        'source-tag'
      )
    }
  )

  it.each(['unstaged', 'staged', 'untracked'])(
    'rejects %s content',
    async (mode) => {
      const { root, commit } = await fixture()
      await writeFile(
        path.join(
          root,
          mode === 'untracked' ? 'unknown-source.ts' : 'source.js'
        ),
        'changed\n'
      )
      if (mode === 'staged') git(root, 'add', 'source.js')
      failed(
        await verifyWindowsStoreSource({
          repoRoot: root,
          metadata: metadata(commit),
        }),
        'clean-worktree'
      )
    }
  )

  it('rejects missing origin/main without consulting a same-named branch', async () => {
    const { root, commit } = await fixture()
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(root, 'branch', 'origin/main')
    failed(
      await verifyWindowsStoreSource({
        repoRoot: root,
        metadata: metadata(commit),
      }),
      'origin-main-ancestry'
    )
  })

  it('rejects a source commit ahead of local origin/main', async () => {
    const { root } = await fixture()
    git(root, 'commit', '--allow-empty', '-m', 'not on main')
    const commit = git(root, 'rev-parse', 'HEAD')
    git(root, 'tag', '-f', 'v2.0.0')
    failed(
      await verifyWindowsStoreSource({
        repoRoot: root,
        metadata: metadata(commit),
      }),
      'origin-main-ancestry'
    )
  })

  it.each(['replace', 'graft', 'assume-unchanged', 'skip-worktree', 'filter'])(
    'rejects %s shortcuts before status',
    async (mode) => {
      const { root, commit } = await fixture()
      if (mode === 'replace') {
        git(root, 'commit', '--allow-empty', '-m', 'replacement')
        git(root, 'replace', commit, 'HEAD')
      } else if (mode === 'graft') {
        await mkdir(path.join(root, '.git', 'info'), { recursive: true })
        await writeFile(
          path.join(root, '.git', 'info', 'grafts'),
          `${commit}\n`
        )
      } else if (mode === 'filter') {
        git(root, 'config', 'filter.fixture.clean', 'must-never-run')
      } else {
        git(root, 'update-index', `--${mode}`, 'source.js')
        await writeFile(path.join(root, 'source.js'), 'hidden change\n')
      }
      failed(
        await verifyWindowsStoreSource({
          repoRoot: root,
          metadata: metadata(commit),
        }),
        'git-integrity'
      )
      expect(
        vi
          .mocked(execFile)
          .mock.calls.some(([, args]) => args?.includes('status'))
      ).toBe(false)
    }
  )

  it.each(['clean', 'tracked', 'untracked'])(
    'rejects %s submodules before recursive status',
    async (mode) => {
      const parent = await fixture()
      const child = await fixture()
      git(
        parent.root,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        child.root,
        'child'
      )
      git(parent.root, 'commit', '-am', 'add child')
      const commit = git(parent.root, 'rev-parse', 'HEAD')
      git(parent.root, 'tag', '-f', 'v2.0.0')
      git(parent.root, 'update-ref', 'refs/remotes/origin/main', commit)
      git(parent.root, 'config', 'submodule.child.ignore', 'all')
      if (mode !== 'clean')
        await writeFile(
          path.join(
            parent.root,
            'child',
            mode === 'tracked' ? 'source.js' : 'unknown.ts'
          ),
          'dirty\n'
        )
      git(
        path.join(parent.root, 'child'),
        'config',
        'filter.fixture.clean',
        'must-never-run'
      )
      failed(
        await verifyWindowsStoreSource({
          repoRoot: parent.root,
          metadata: metadata(commit),
        }),
        'git-integrity'
      )
      expect(
        vi
          .mocked(execFile)
          .mock.calls.some(([, args]) => args?.includes('status'))
      ).toBe(false)
    }
  )

  it('ignores inherited Git repository and index redirection', async () => {
    const { root, commit } = await fixture()
    vi.stubEnv('GIT_DIR', '/must-not-be-used')
    vi.stubEnv('GIT_WORK_TREE', '/must-not-be-used')
    vi.stubEnv('GIT_INDEX_FILE', '/must-not-be-used')
    vi.stubEnv('git_object_directory', '/must-not-be-used')
    expect(
      (
        await verifyWindowsStoreSource({
          repoRoot: root,
          metadata: metadata(commit),
        })
      ).ok
    ).toBe(true)
    for (const [, , options] of vi.mocked(execFile).mock.calls) {
      expect(options).toMatchObject({
        env: expect.not.objectContaining({
          git_object_directory: expect.anything(),
        }),
      })
    }
  })

  it('prints JSON from the CLI without writing a report into the checkout', async () => {
    const { root, commit } = await fixture()
    const metadataDir = await mkdtemp(
      path.join(tmpdir(), 'motrix-source-input-')
    )
    roots.push(metadataDir)
    const input = path.join(metadataDir, 'metadata.json')
    await writeFile(input, JSON.stringify(metadata(commit)))
    const stdout = execFileSync(
      process.execPath,
      [script, '--metadata', input, '--repo-root', root],
      { encoding: 'utf8', env }
    )
    expect(JSON.parse(stdout).ok).toBe(true)
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    await writeFile(path.join(root, 'unexpected-source.js'), 'untracked\n')
    let failedRun: { status: number; stdout: string } | undefined
    try {
      execFileSync(
        process.execPath,
        [script, '--metadata', input, '--repo-root', root],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      failedRun = error as typeof failedRun
    }
    expect(failedRun?.status).toBe(1)
    const report = JSON.parse(failedRun!.stdout)
    failed(report, 'clean-worktree')
    expect(report).toMatchObject({
      payloadSourceVerified: false,
      protectedTagVerified: false,
      networkFreshnessVerified: false,
    })
  })
})
