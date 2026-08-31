import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript verification script intentionally has no declarations
import {
  validateRemoteExtensionCompatibilityManifest,
  verifyPinnedCommit,
  verifyRemoteExtensionCompatibility,
} from '../../scripts/verify-remote-extension-compatibility.mjs'

function validManifest(
  extensionCommit = 'a'.repeat(40),
  motrixCommit = 'b'.repeat(40)
) {
  return {
    schemaVersion: 1,
    protocol: 'MDXP-over-MBP1',
    extension: {
      repository: 'motrix-extension',
      commit: extensionCommit,
    },
    motrix: {
      repository: 'motrix-app',
      commit: motrixCommit,
    },
    e2e: {
      browserCases: 5,
      command: 'pnpm test:e2e:remote-extension',
    },
  }
}

function createRepository(root: string, name: string) {
  const repository = join(root, name)
  execFileSync('git', ['init', repository], { stdio: 'ignore' })
  writeFileSync(join(repository, 'evidence.txt'), `${name}\n`)
  execFileSync('git', ['-C', repository, 'add', 'evidence.txt'])
  execFileSync(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Compatibility Test',
      '-c',
      'user.email=compatibility@example.invalid',
      'commit',
      '-m',
      'test: implementation evidence',
    ],
    { stdio: 'ignore' }
  )
  return {
    repository,
    commit: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
  }
}

describe('remote Extension compatibility manifest', () => {
  it('accepts only the exact v1 compatibility contract', () => {
    expect(
      validateRemoteExtensionCompatibilityManifest(validManifest())
    ).toEqual(validManifest())
  })

  it.each([
    'abc123',
    'A'.repeat(40),
    '0'.repeat(40),
    'f'.repeat(40),
    'REPLACE_WITH_EXTENSION_IMPLEMENTATION_COMMIT',
  ])('rejects unsafe commit value %j', (commit) => {
    expect(() =>
      validateRemoteExtensionCompatibilityManifest(validManifest(commit))
    ).toThrow(/full lowercase SHA/)
  })

  it('rejects protocol drift, insufficient browser cases, and unknown fields', () => {
    expect(() =>
      validateRemoteExtensionCompatibilityManifest({
        ...validManifest(),
        protocol: 'legacy-token',
      })
    ).toThrow(/MDXP-over-MBP1/)
    expect(() =>
      validateRemoteExtensionCompatibilityManifest({
        ...validManifest(),
        e2e: {
          browserCases: 4,
          command: 'pnpm test:e2e:remote-extension',
        },
      })
    ).toThrow(/integer >= 5/)
    expect(() =>
      validateRemoteExtensionCompatibilityManifest({
        ...validManifest(),
        fallback: 'token',
      })
    ).toThrow(/exactly/)
  })

  it('requires each pin to resolve as a commit in the matching repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'motrix-compatibility-'))
    const extension = createRepository(root, 'extension')
    const motrix = createRepository(root, 'motrix')
    const manifestPath = join(root, 'compatibility.json')
    writeFileSync(
      manifestPath,
      `${JSON.stringify(validManifest(extension.commit, motrix.commit), null, 2)}\n`
    )

    expect(
      verifyRemoteExtensionCompatibility({
        manifestPath,
        extensionRepository: extension.repository,
        motrixRepository: motrix.repository,
      })
    ).toEqual(validManifest(extension.commit, motrix.commit))

    expect(() =>
      verifyPinnedCommit(extension.repository, motrix.commit, 'Extension')
    ).toThrow(/does not resolve/)
  })

  it('keeps the checked-in example intentionally unpinned', () => {
    const example = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'e2e/bridge/remote-extension-compatibility.example.json'
        ),
        'utf8'
      )
    )
    expect(() => validateRemoteExtensionCompatibilityManifest(example)).toThrow(
      /full lowercase SHA/
    )
  })
})
