import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error JavaScript build tooling
import {
  buildTaiji,
  prepareOfflineSource,
  prepareSource,
  readEngineSource,
  sha256Hex,
} from '../../scripts/build-taiji.mjs'
// @ts-expect-error JavaScript build tooling
import { verifyEngineArtifact } from '../../scripts/verify-engine-artifact.mjs'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-taiji-build-'))
  directories.push(root)
  const scripts = path.join(root, 'scripts')
  await mkdir(scripts)
  const source = {
    repository: 'https://github.com/motrixapp/taiji.git',
    revision: 'a'.repeat(40),
    cargoLockSha256: sha256Hex('locked cargo graph'),
  }
  const lock = {
    engine: 'taiji',
    version: '0.2.0',
    assets: {
      'darwin-arm64': { bin: 'taiji', rustTarget: 'aarch64-apple-darwin' },
    },
  }
  await writeFile(
    path.join(scripts, 'taiji-source.lock.json'),
    JSON.stringify(source)
  )
  await writeFile(path.join(scripts, 'engine.lock.json'), JSON.stringify(lock))
  const { sourceDigest } = await readEngineSource(root)
  const directory = path.join(root, 'extra/darwin/arm64')
  await mkdir(directory, { recursive: true })
  const binary = path.join(directory, 'taiji')
  const license = path.join(directory, 'taiji-licenses.txt')
  const receipt = path.join(directory, 'taiji-build.json')
  await writeFile(binary, 'test binary')
  await writeFile(license, 'license notices')
  const record = {
    version: lock.version,
    sourceDigest,
    profile: 'release',
    digestAlgorithm: 'native-content-v1',
    nativePayloadSha256: sha256Hex('test binary'),
    target: 'aarch64-apple-darwin',
    binarySha256: sha256Hex('test binary'),
    licenseSha256: sha256Hex('license notices'),
  }
  await writeFile(receipt, JSON.stringify(record))
  return { root, scripts, binary, license, receipt, record }
}

describe('pinned taiji build', () => {
  it('reuses a verified source, binary and license receipt without fetching or rebuilding', async () => {
    const f = await fixture()
    expect(
      await buildTaiji({ root: f.root, platform: 'darwin', arch: 'arm64' })
    ).toBe(f.binary)
    expect(
      await verifyEngineArtifact(
        f.binary,
        f.receipt,
        f.license,
        { platform: 'darwin', arch: 'arm64' },
        f.root
      )
    ).toMatchObject({ version: '0.2.0' })
  })
  it('rejects a malformed source lock before using cached binaries', async () => {
    const f = await fixture()
    const file = path.join(f.scripts, 'taiji-source.lock.json')
    const source = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(
      file,
      JSON.stringify({ ...source, cargoLockSha256: 'invalid' })
    )
    await expect(
      buildTaiji({ root: f.root, platform: 'darwin', arch: 'arm64' })
    ).rejects.toThrow('Invalid taiji source lock')
    expect(await readFile(f.binary, 'utf8')).toBe('test binary')
  })
  it('fetches the exact upstream source and rejects modified cached files', async () => {
    const f = await fixture()
    const repository = path.join(f.root, 'upstream')
    await mkdir(repository)
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
    git('init', '--quiet')
    await writeFile(path.join(repository, 'Cargo.lock'), 'locked graph')
    await writeFile(path.join(repository, 'engine.rs'), 'original engine')
    git('add', '.')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    )
    const source = {
      repository,
      revision: git('rev-parse', 'HEAD').trim(),
      cargoLockSha256: sha256Hex('locked graph'),
    }
    const directory = await prepareSource({ source }, repository, f.root)
    expect(await readFile(path.join(directory, 'engine.rs'), 'utf8')).toBe(
      'original engine'
    )
    expect(await prepareSource({ source }, repository, f.root)).toBe(directory)
    await writeFile(path.join(directory, 'engine.rs'), 'modified engine')
    await expect(
      prepareSource({ source }, repository, f.root)
    ).rejects.toThrow()
  })
  it.each(['binary', 'license', 'profile', 'target', 'sourceDigest'])(
    'refuses packaging after %s tampering',
    async (field) => {
      const f = await fixture()
      if (field === 'binary' || field === 'license')
        await writeFile(f[field], 'changed')
      else
        await writeFile(
          f.receipt,
          JSON.stringify({ ...f.record, [field]: 'changed' })
        )
      await expect(
        verifyEngineArtifact(
          f.binary,
          f.receipt,
          f.license,
          { platform: 'darwin', arch: 'arm64' },
          f.root
        )
      ).rejects.toThrow('locked source build')
    }
  )
  it('rejects unsupported targets without selecting another engine', async () => {
    const f = await fixture()
    await expect(
      buildTaiji({ root: f.root, platform: 'android', arch: 'arm64' })
    ).rejects.toThrow('Unsupported taiji target')
  })
  it('verifies an offline Flatpak source and rejects Cargo lock drift', async () => {
    const f = await fixture()
    const directory = path.join(f.root, 'taiji-source')
    await mkdir(directory)
    await writeFile(path.join(directory, 'Cargo.lock'), 'locked graph')
    const info = { source: { cargoLockSha256: sha256Hex('locked graph') } }
    vi.stubEnv('MOTRIX_FLATPAK_BUILD', '1')
    try {
      expect(await prepareOfflineSource(info, directory, f.root)).toBe(
        directory
      )
      expect(await readFile(path.join(directory, 'Cargo.lock'), 'utf8')).toBe(
        'locked graph'
      )
      await writeFile(path.join(directory, 'Cargo.lock'), 'changed graph')
      await expect(
        prepareOfflineSource(info, directory, f.root)
      ).rejects.toThrow('locked Cargo graph')
      await expect(
        prepareOfflineSource(info, path.join(f.root, 'outside'), f.root)
      ).rejects.toThrow('restricted')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
