import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyUpdateArtifacts } from '../../scripts/verify-update-artifacts.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  )
})

describe('verifyUpdateArtifacts', () => {
  it('accepts a matching manifest and referenced macOS ZIP', async () => {
    const fixture = await createFixture()

    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).resolves.toEqual({
      manifests: ['latest-mac.yml'],
      assets: ['Motrix-2.0.0-arm64.zip'],
    })
  })

  it('accepts the architecture-specific Linux arm64 manifest', async () => {
    const fixture = await makeTempDir()
    const deb = Buffer.from('signed Linux arm64 deb')
    const rpm = Buffer.from('signed Linux arm64 rpm')
    const appImage = Buffer.from('signed Linux arm64 AppImage')
    const debName = 'Motrix_2.0.0_arm64.deb'
    const rpmName = 'Motrix-2.0.0.aarch64.rpm'
    const appImageName = 'Motrix-2.0.0-arm64.AppImage'
    await writeFile(path.join(fixture, debName), deb)
    await writeFile(path.join(fixture, rpmName), rpm)
    await writeFile(path.join(fixture, appImageName), appImage)
    await writeFile(
      path.join(fixture, `${appImageName}.zsync`),
      zsync(appImageName, appImage)
    )
    await writeFile(
      path.join(fixture, 'latest-linux-arm64.yml'),
      manifest(
        [
          { name: debName, content: deb },
          { name: rpmName, content: rpm },
          { name: appImageName, content: appImage },
        ],
        debName
      )
    )

    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).resolves.toEqual({
      manifests: ['latest-linux-arm64.yml'],
      assets: [debName, rpmName, appImageName, `${appImageName}.zsync`],
    })
  })

  it('can require the complete multi-platform manifest set', async () => {
    const fixture = await createFixture()

    await expect(
      verifyUpdateArtifacts({
        directory: fixture,
        version: '2.0.0',
        requireAll: true,
      })
    ).rejects.toThrow(
      'Missing required update manifests: latest.yml, latest-linux.yml, latest-linux-arm64.yml, beta.yml, beta-mac.yml, beta-linux.yml, beta-linux-arm64.yml'
    )
  })

  it('accepts a complete beta-only channel and rejects stable pollution', async () => {
    const fixture = await makeTempDir()
    const version = '2.1.0-beta.1'
    const asset = Buffer.from('signed beta macOS zip')
    const name = `Motrix-${version}-arm64.zip`
    await writeFile(path.join(fixture, name), asset)
    const content = manifest(
      [{ name, content: asset }],
      name,
      undefined,
      version
    )
    await writeFile(path.join(fixture, 'beta-mac.yml'), content)

    await expect(
      verifyUpdateArtifacts({ directory: fixture, version, channel: 'beta' })
    ).resolves.toEqual({
      manifests: ['beta-mac.yml'],
      assets: [name],
    })

    await writeFile(path.join(fixture, 'latest-mac.yml'), content)
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version, channel: 'beta' })
    ).rejects.toThrow('Unexpected update manifests for beta: latest-mac.yml')
  })

  it('rejects malformed prerelease versions outside workflow preflight', async () => {
    await expect(
      verifyUpdateArtifacts({
        directory: '.',
        version: '2.1.0-beta..1',
        channel: 'beta',
      })
    ).rejects.toThrow('release version must be strict SemVer')
  })

  it('rejects a mismatched release version', async () => {
    const fixture = await createFixture()
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.1' })
    ).rejects.toThrow('does not match 2.0.1')
  })

  it('rejects traversal names and missing assets', async () => {
    const fixture = await makeTempDir()
    await writeFile(
      path.join(fixture, 'latest.yml'),
      'version: 2.0.0\nfiles:\n  - url: ../secret\n    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n    size: 1\npath: ../secret\nsha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n'
    )
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('not a safe name')

    const missing = await makeTempDir()
    await writeFile(
      path.join(missing, 'latest.yml'),
      manifest(
        [{ name: 'missing.exe', content: Buffer.from('missing') }],
        'missing.exe'
      )
    )
    await expect(
      verifyUpdateArtifacts({ directory: missing, version: '2.0.0' })
    ).rejects.toThrow('referenced asset is missing')
  })

  it('rejects size and checksum mismatches', async () => {
    const fixture = await makeTempDir()
    const asset = Buffer.from('asset')
    await writeFile(path.join(fixture, 'Motrix.exe'), asset)
    await writeFile(
      path.join(fixture, 'latest.yml'),
      manifest(
        [{ name: 'Motrix.exe', content: asset, size: asset.length + 1 }],
        'Motrix.exe'
      )
    )
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('does not match manifest')

    await writeFile(
      path.join(fixture, 'latest.yml'),
      manifest(
        [
          {
            name: 'Motrix.exe',
            content: Buffer.from('different'),
            size: asset.length,
          },
        ],
        'Motrix.exe'
      )
    )
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('sha512 does not match')
  })

  it('rejects legacy metadata that does not select the target updater', async () => {
    const fixture = await makeTempDir()
    const deb = Buffer.from('deb')
    const rpm = Buffer.from('rpm')
    const debName = 'Motrix_2.0.0_amd64.deb'
    const rpmName = 'Motrix-2.0.0.x86_64.rpm'
    await writeFile(path.join(fixture, debName), deb)
    await writeFile(path.join(fixture, rpmName), rpm)
    await writeFile(
      path.join(fixture, 'latest-linux.yml'),
      manifest(
        [
          { name: debName, content: deb },
          { name: rpmName, content: rpm },
        ],
        rpmName
      )
    )

    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('legacy path must reference a .deb asset')

    await writeFile(
      path.join(fixture, 'latest-linux.yml'),
      manifest(
        [
          { name: debName, content: deb },
          { name: rpmName, content: rpm },
        ],
        debName,
        sha512(Buffer.from('wrong legacy checksum'))
      )
    )
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('legacy path/sha512 does not match files[]')
  })

  it('requires deb, rpm, and AppImage entries in Linux update manifests', async () => {
    const fixture = await makeTempDir()
    const deb = Buffer.from('deb only')
    const debName = 'Motrix_2.0.0_amd64.deb'
    await writeFile(path.join(fixture, debName), deb)
    await writeFile(
      path.join(fixture, 'latest-linux.yml'),
      manifest([{ name: debName, content: deb }], debName)
    )

    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('a .rpm asset is required for auto-update')

    // With deb + rpm but no AppImage, the AppImage requirement is what fails.
    const rpm = Buffer.from('rpm')
    const rpmName = 'Motrix-2.0.0.x86_64.rpm'
    await writeFile(path.join(fixture, rpmName), rpm)
    await writeFile(
      path.join(fixture, 'latest-linux.yml'),
      manifest(
        [
          { name: debName, content: deb },
          { name: rpmName, content: rpm },
        ],
        debName
      )
    )
    await expect(
      verifyUpdateArtifacts({ directory: fixture, version: '2.0.0' })
    ).rejects.toThrow('a .AppImage asset is required for auto-update')
  })
})

async function createFixture() {
  const fixture = await makeTempDir()
  const asset = Buffer.from('signed macOS zip')
  const name = 'Motrix-2.0.0-arm64.zip'
  await writeFile(path.join(fixture, name), asset)
  await writeFile(
    path.join(fixture, 'latest-mac.yml'),
    manifest([{ name, content: asset }], name)
  )
  return fixture
}

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'motrix-update-assets-'))
  tempDirs.push(dir)
  return dir
}

function manifest(
  assets: Array<{ name: string; content: Buffer; size?: number }>,
  legacyName: string,
  legacySha512?: string,
  version = '2.0.0'
) {
  const legacy = assets.find((asset) => asset.name === legacyName)
  if (!legacy) throw new Error(`Missing legacy fixture ${legacyName}`)
  const files = assets
    .map(
      (asset) =>
        `  - url: ${asset.name}\n` +
        `    sha512: ${sha512(asset.content)}\n` +
        `    size: ${asset.size ?? asset.content.length}\n`
    )
    .join('')
  return (
    `version: ${version}\nfiles:\n${files}` +
    `path: ${legacyName}\n` +
    `sha512: ${legacySha512 ?? sha512(legacy.content)}\n`
  )
}

function zsync(name: string, content: Buffer) {
  return (
    'zsync: 0.6.2\n' +
    `Filename: ${name}\n` +
    'Blocksize: 2048\n' +
    `Length: ${content.length}\n` +
    'Hash-Lengths: 1,2,4\n' +
    `URL: ${name}\n` +
    `SHA-1: ${createHash('sha1').update(content).digest('hex')}\n\n` +
    'checksum-payload'
  )
}

function sha512(content: Buffer) {
  return createHash('sha512').update(content).digest('base64')
}
