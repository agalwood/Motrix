// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWindowsStoreBuild } from '../../scripts/prepare-windows-store-build.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'

const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'motrix-store-build-'))
  roots.push(directory)
  const root = path.join(directory, 'source')
  await mkdir(root)
  git(root, 'init', '--template=', '--initial-branch=main')
  git(root, 'config', 'user.name', 'Build preparation fixture')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(
    path.join(root, 'package.json'),
    '{"version":"2.0.0-beta.41"}\n'
  )
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'fixture: true\n')
  await writeFile(
    path.join(root, 'electron-builder.json'),
    await readFile('electron-builder.json')
  )
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'fixture')
  return {
    repoRoot: root,
    outputDirectory: path.join(directory, 'prepared'),
    metadata: {
      schemaVersion: 1,
      profile: 'test',
      architecture: 'x64',
      productVersion: '2.0.0-beta.41',
      packageVersion: '1.0.0.0',
      source: { commit: git(root, 'rev-parse', 'HEAD') },
      identity: WINDOWS_STORE_TEST_IDENTITY,
    },
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store build preparation', () => {
  it('writes complete inputs without executing a build or changing the checkout', async () => {
    const options = await fixture()
    const plan = await prepareWindowsStoreBuild(options)
    expect(plan).toMatchObject({
      target: 'win32-x64',
      productVersion: '2.0.0-beta.41',
      packageVersion: '1.0.0.0',
      sourceCheckoutChecked: true,
      buildExecuted: false,
      payloadSourceVerified: false,
      windowsRuntimeVerified: false,
      storeSubmissionReady: false,
    })
    expect(await readdir(options.outputDirectory)).toEqual([
      'build-plan.json',
      'electron-builder.json',
      'release-metadata.json',
      'source-report.json',
    ])
    const config = JSON.parse(
      await readFile(
        path.join(options.outputDirectory, 'electron-builder.json'),
        'utf8'
      )
    )
    expect(config).toMatchObject({
      extends: null,
      publish: null,
      win: { publish: null, target: [{ target: 'dir', arch: ['x64'] }] },
    })
    expect(plan.builder.args).toEqual([
      'exec',
      'electron-builder',
      '--config',
      path.join(config.directories.output, '..', 'electron-builder.json'),
      '--win',
      '--x64',
      '--publish',
      'never',
    ])
    expect(
      JSON.parse(
        await readFile(
          path.join(options.outputDirectory, 'source-report.json'),
          'utf8'
        )
      ).ok
    ).toBe(true)
    expect(git(options.repoRoot, 'status', '--porcelain')).toBe('')
    for (const hash of Object.values(plan.inputs))
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never overwrites a previous preparation', async () => {
    const options = await fixture()
    await prepareWindowsStoreBuild(options)
    const before = await readFile(
      path.join(options.outputDirectory, 'build-plan.json')
    )
    await expect(prepareWindowsStoreBuild(options)).rejects.toThrow(
      'already exists'
    )
    expect(
      await readFile(path.join(options.outputDirectory, 'build-plan.json'))
    ).toEqual(before)
  })

  it.each(['checkout', 'inside', 'relative', 'missing-parent'])(
    'rejects an unsafe output before writing: %s',
    async (mode) => {
      const options = await fixture()
      const original = options.outputDirectory
      options.outputDirectory = {
        checkout: options.repoRoot,
        inside: path.join(options.repoRoot, 'generated'),
        relative: 'relative-output',
        'missing-parent': path.join(original, 'child'),
      }[mode] as string
      await expect(prepareWindowsStoreBuild(options)).rejects.toThrow()
      expect(git(options.repoRoot, 'status', '--porcelain')).toBe('')
      await expect(lstat(original)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('resolves an output parent alias before checking source overlap', async () => {
    const options = await fixture()
    const alias = path.join(path.dirname(options.outputDirectory), 'alias')
    await symlink(
      options.repoRoot,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    options.outputDirectory = path.join(alias, 'generated')
    await expect(prepareWindowsStoreBuild(options)).rejects.toThrow('outside')
    await expect(
      lstat(path.join(options.repoRoot, 'generated'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['dirty-source', 'wrong-commit', 'wrong-config'])(
    'does not leave output when input verification fails: %s',
    async (mode) => {
      const options = await fixture()
      if (mode === 'dirty-source')
        await writeFile(path.join(options.repoRoot, 'untracked.txt'), 'changed')
      if (mode === 'wrong-commit')
        options.metadata.source.commit = 'a'.repeat(40)
      if (mode === 'wrong-config') {
        await writeFile(
          path.join(options.repoRoot, 'electron-builder.json'),
          '{}'
        )
        git(options.repoRoot, 'commit', '-am', 'invalid config')
        options.metadata.source.commit = git(
          options.repoRoot,
          'rev-parse',
          'HEAD'
        )
      }
      await expect(prepareWindowsStoreBuild(options)).rejects.toThrow()
      await expect(lstat(options.outputDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  it('exposes the same preparation through the CLI with strict arguments', async () => {
    const options = await fixture()
    const metadataFile = path.join(
      path.dirname(options.outputDirectory),
      'input.json'
    )
    await writeFile(metadataFile, JSON.stringify(options.metadata))
    const script = path.resolve('scripts/prepare-windows-store-build.mjs')
    const args = [
      script,
      '--metadata',
      metadataFile,
      '--repo-root',
      options.repoRoot,
      '--out',
      options.outputDirectory,
    ]
    const output = execFileSync(process.execPath, args, {
      env,
      encoding: 'utf8',
    })
    expect(JSON.parse(output).buildExecuted).toBe(false)
    expect(() =>
      execFileSync(process.execPath, [...args, '--publish'], {
        env,
        stdio: 'pipe',
      })
    ).toThrow()
  })
})
