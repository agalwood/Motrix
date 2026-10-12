// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWindowsStoreIdentityCases } from '../../scripts/prepare-windows-store-identity-cases.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import {
  createWindowsStorePayloadFixture,
  WINDOWS_STORE_PAYLOAD_METADATA,
  writeWindowsStoreRuntimeIdentityFixture,
} from '../helpers/windows-store-payload-fixture'

const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
async function fixture() {
  const input = await createWindowsStorePayloadFixture()
  roots.push(input.root)
  const repoRoot = path.join(input.root, 'checkout')
  await mkdir(repoRoot)
  git(repoRoot, 'init', '--template=', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Identity case fixture')
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(repoRoot, 'package.json'), '{"version":"1.2.3"}\n')
  await cp(path.resolve('build/appx'), path.join(repoRoot, 'build/appx'), {
    recursive: true,
  })
  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-m', 'fixture')
  const metadata = {
    ...WINDOWS_STORE_PAYLOAD_METADATA,
    profile: 'test',
    identity: WINDOWS_STORE_TEST_IDENTITY,
    packageVersion: '1.0.0.0',
    source: { commit: git(repoRoot, 'rev-parse', 'HEAD') },
  }
  await writeWindowsStoreRuntimeIdentityFixture(input.appDir, metadata)
  return {
    ...input,
    repoRoot,
    metadata,
    packageFamilyName: 'Motrix.Store.Test_123456789abcd',
    outputDirectory: path.join(input.root, 'cases'),
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    )
  )
})
describe('fixed installed identity rejection and upgrade cases', () => {
  it('binds distinct increasing versions while preserving the baseline and all application bytes', async () => {
    const options = await fixture()
    const file = path.join(
      options.appDir,
      'resources/windows-package-identity.json'
    )
    const before = await readFile(file)
    const report = await prepareWindowsStoreIdentityCases(options)
    expect(report).toMatchObject({
      sourceCommit: options.metadata.source.commit,
      installed: false,
      storeReady: false,
    })
    expect(
      report.cases.map((row: { packageVersion: string }) => row.packageVersion)
    ).toEqual(['1.0.1.0', '1.0.2.0'])
    for (const row of report.cases) {
      expect(row.unchangedApplicationPayloadVerified).toBe(true)
      const value = JSON.parse(
        await readFile(
          path.join(
            options.outputDirectory,
            row.preparedDirectory,
            'layout/app/resources/windows-package-identity.json'
          ),
          'utf8'
        )
      )
      expect(value.expected.version).toBe(row.packageVersion)
      expect(value.sourceCommit).toBe(options.metadata.source.commit)
      expect(value.expected.familyName === options.packageFamilyName).toBe(
        row.expectedStartup === 'accepted'
      )
    }
    expect(await readFile(file)).toEqual(before)
    expect(git(options.repoRoot, 'status', '--porcelain')).toBe('')
    await expect(prepareWindowsStoreIdentityCases(options)).rejects.toThrow(
      'already exists'
    )
  })
  it('refuses production inputs rather than creating a signed or publishable fixture', async () => {
    const options = await fixture()
    await expect(
      prepareWindowsStoreIdentityCases({
        ...options,
        metadata: WINDOWS_STORE_PAYLOAD_METADATA,
      })
    ).rejects.toThrow('fixed ordinary test baseline')
  })
})
