import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  parseArgs,
  prepareFlatpakProject,
  replaceApplicationSource,
} from '../../scripts/prepare-flatpak-project.mjs'

const require = createRequire(import.meta.url)
const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const parseYaml = require('js-yaml').load as (source: string) => unknown
const manifest = parseYaml(
  readFileSync(
    path.join(process.cwd(), 'flatpak/app.motrix.native.yml'),
    'utf8'
  )
) as {
  modules: Array<{
    name: string
    sources: unknown[]
    'build-options'?: { env?: Record<string, string> }
  }>
}

describe('prepare-flatpak-project', () => {
  it.each(['2.0.0', '2.0.0-beta.40'])(
    'pins the archived commit, version and branch for %s',
    async (version) => {
      const { root, git, options } = createSourceFixture(version)
      const result = await prepareFlatpakProject(options, root)
      const prepared = parseYaml(readFileSync(result.manifestPath, 'utf8')) as {
        branch: string
        modules: Array<{ sources: Array<{ sha256: string }> }>
      }
      expect(prepared.branch).toBe(version.includes('-') ? 'beta' : 'stable')
      expect(prepared.modules[0]?.sources[0]?.sha256).toBe(
        createHash('sha256')
          .update(readFileSync(result.archivePath))
          .digest('hex')
      )
      const archivedPackage = execFileSync(
        'tar',
        ['-xOf', result.archivePath, 'package.json'],
        {
          encoding: 'utf8',
        }
      )
      expect(JSON.parse(archivedPackage).version).toBe(version)
      expect(readFileSync(options['github-output'], 'utf8')).toContain(
        `revision=${git('rev-parse', 'HEAD')}`
      )
      expect(result.version).toBe(version)
    }
  )

  it('rejects a release version that differs from the archived source', async () => {
    const { root, options } = createSourceFixture('2.0.0-beta.40')
    await expect(
      prepareFlatpakProject({ ...options, version: '2.0.0-beta.39' }, root)
    ).rejects.toThrow('does not match release version')
  })

  it('rejects archiving a different commit than the dependency checkout', async () => {
    const { root, git, options } = createSourceFixture('2.0.0')
    git('commit', '--allow-empty', '-m', 'next source')
    await expect(
      prepareFlatpakProject({ ...options, ref: 'HEAD~1' }, root)
    ).rejects.toThrow('must match the checked-out commit')
  })

  it('rejects stale AppStream metadata before producing a release bundle', async () => {
    const { root, options } = createSourceFixture('2.0.0')
    writeFileSync(
      path.join(root, 'flatpak/app.motrix.native.metainfo.xml'),
      '<component><releases><release version="1.0.0"/></releases></component>'
    )
    await expect(prepareFlatpakProject(options, root)).rejects.toThrow(
      'AppStream version must match'
    )
  })

  it('replaces only the application git source with the CI archive', () => {
    const prepared = replaceApplicationSource(
      manifest,
      'motrix-source.tar.gz'
    ) as typeof manifest
    const originalMotrix = manifest.modules.find(
      (candidate) => candidate.name === 'motrix'
    )
    const preparedMotrix = prepared.modules.find(
      (candidate) => candidate.name === 'motrix'
    )

    expect(preparedMotrix?.sources[0]).toEqual({
      type: 'archive',
      path: 'motrix-source.tar.gz',
      'strip-components': 0,
    })
    expect(preparedMotrix?.sources.slice(1)).toEqual(
      originalMotrix?.sources.slice(1)
    )
    expect(
      prepared.modules.find((candidate) => candidate.name === 'aria2')
    ).toEqual(manifest.modules.find((candidate) => candidate.name === 'aria2'))
  })

  it('rejects an ambiguous application source', () => {
    expect(() =>
      replaceApplicationSource(
        {
          modules: [
            {
              name: 'motrix',
              sources: [
                { type: 'git', url: 'https://example.test/a.git' },
                { type: 'git', url: 'https://example.test/b.git' },
              ],
            },
          ],
        },
        'source.tar.gz'
      )
    ).toThrow('exactly one git source')
  })

  it('pins the sandbox node-gyp headers to the packaged electron version', () => {
    // generated-sources unpacks the electron release headers under
    // flatpak-node/cache/node-gyp/<electron version>; a stale nodedir makes
    // electron-rebuild's gyp fail on a dangling include path (run
    // 31363983647 shipped 43.3.0 sources against a 43.2.0 nodedir).
    const electronVersion = (
      JSON.parse(
        readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
      ) as { devDependencies: Record<string, string> }
    ).devDependencies.electron.replace(/^[~^]/, '')
    const motrix = manifest.modules.find(
      (candidate) => candidate.name === 'motrix'
    )
    expect(motrix?.['build-options']?.env?.npm_config_nodedir).toBe(
      `/run/build/motrix/flatpak-node/cache/node-gyp/${electronVersion}`
    )
  })

  it('parses explicit workflow paths and rejects unknown flags', () => {
    expect(
      parseArgs([
        '--manifest',
        'flatpak/release.yml',
        '--output',
        'flatpak/ci.yml',
        '--archive',
        'flatpak/source.tar.gz',
        '--ref',
        'abc123',
      ])
    ).toEqual({
      manifest: 'flatpak/release.yml',
      output: 'flatpak/ci.yml',
      archive: 'flatpak/source.tar.gz',
      ref: 'abc123',
      version: '',
      'github-output': '',
    })
    expect(() => parseArgs(['--surprise', 'value'])).toThrow('unknown flag')
  })
})

function createSourceFixture(version: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'motrix-flatpak-source-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'flatpak'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(
    path.join(root, 'flatpak/app.motrix.native.yml'),
    'modules:\n  - name: motrix\n    sources:\n      - type: git\n        url: https://example.test/motrix.git\n'
  )
  writeFileSync(
    path.join(root, 'flatpak/app.motrix.native.metainfo.xml'),
    `<component><releases><release version="${version}"/></releases></component>`
  )
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.email', 'flatpak-test@example.test')
  git('config', 'user.name', 'Flatpak test')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '--quiet', '-m', 'source')
  const options = parseArgs([
    '--version',
    version,
    '--github-output',
    path.join(root, 'github-output'),
  ])
  return { root, git, options }
}
