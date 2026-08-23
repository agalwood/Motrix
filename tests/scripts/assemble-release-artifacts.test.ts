import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleReleaseArtifacts } from '../../scripts/assemble-release-artifacts.mjs'
import { verifyUpdateArtifacts } from '../../scripts/verify-update-artifacts.mjs'

const VERSION = '2.0.0'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  )
})

describe('assembleReleaseArtifacts', () => {
  it('flattens five targets and merges both macOS updater files', async () => {
    const fixture = await createFixture()

    const result = await assembleReleaseArtifacts({
      inputDirectory: fixture.input,
      outputDirectory: fixture.output,
      version: VERSION,
    })

    expect(result.targets).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
    ])
    expect(result.manifests).toHaveLength(8)
    expect(await readdir(fixture.output)).toEqual(
      expect.arrayContaining([
        'Motrix-2.0.0-arm64.AppImage',
        'Motrix-2.0.0-arm64.AppImage.zsync',
        'Motrix-2.0.0-x86_64.AppImage',
        'Motrix-2.0.0-x86_64.AppImage.zsync',
        'Motrix-2.0.0.aarch64.rpm',
        'Motrix-2.0.0.x86_64.rpm',
        'Motrix-Native-Host-2.0.0-linux-arm64.tar.gz',
        'Motrix-Native-Host-2.0.0-linux-x64.tar.gz',
        'Motrix_2.0.0_amd64.deb',
        'Motrix_2.0.0_arm64.deb',
        'beta-linux-arm64.yml',
        'beta-linux.yml',
        'beta-mac.yml',
        'beta.yml',
        'latest-linux-arm64.yml',
        'latest-linux.yml',
        'latest-mac.yml',
        'latest.yml',
      ])
    )

    const macManifest = load(
      await readFile(path.join(fixture.output, 'latest-mac.yml'), 'utf8')
    ) as {
      files: Array<{ url: string; sha512: string }>
      path: string
      sha512: string
    }
    expect(macManifest.files.map((file) => file.url)).toEqual([
      fixture.names.macX64Zip,
      fixture.names.macArm64Zip,
    ])
    expect(new Set(macManifest.files.map((file) => file.url)).size).toBe(2)
    expect(macManifest.files.some((file) => file.url.endsWith('.dmg'))).toBe(
      false
    )
    expect(macManifest.path).toBe(fixture.names.macX64Zip)
    expect(macManifest.sha512).toBe(macManifest.files[0].sha512)

    for (const manifestName of [
      'latest-linux.yml',
      'beta-linux.yml',
      'latest-linux-arm64.yml',
      'beta-linux-arm64.yml',
    ]) {
      const linuxManifest = load(
        await readFile(path.join(fixture.output, manifestName), 'utf8')
      ) as { files: Array<{ url: string }> }
      expect(linuxManifest.files).toHaveLength(3)
      expect(new Set(linuxManifest.files.map((file) => file.url)).size).toBe(3)
      expect(
        linuxManifest.files.some((file) => file.url.endsWith('.AppImage'))
      ).toBe(true)
    }

    await expect(
      verifyUpdateArtifacts({
        directory: fixture.output,
        version: VERSION,
      })
    ).resolves.toMatchObject({
      manifests: [
        'latest.yml',
        'latest-mac.yml',
        'latest-linux.yml',
        'latest-linux-arm64.yml',
        'beta.yml',
        'beta-mac.yml',
        'beta-linux.yml',
        'beta-linux-arm64.yml',
      ],
    })
    await expect(access(fixture.paths.macArm64Zip)).resolves.toBeUndefined()
  })

  it('rejects conflicting duplicate macOS manifest entries', async () => {
    const fixture = await createFixture()
    await writeManifest(
      fixture.paths.macArm64Manifest,
      VERSION,
      [
        {
          name: fixture.names.macArm64Zip,
          content: fixture.contents.macArm64Zip,
        },
        {
          name: fixture.names.macArm64Dmg,
          content: fixture.contents.macArm64Dmg,
        },
        {
          name: fixture.names.macArm64Dmg,
          content: Buffer.from('conflicting macOS arm64 DMG metadata'),
        },
      ],
      fixture.names.macArm64Zip
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      `darwin-arm64/latest-mac.yml: duplicate manifest asset ${fixture.names.macArm64Dmg} has conflicting metadata`
    )
  })

  it('rejects conflicting duplicate Linux manifest entries', async () => {
    const fixture = await createFixture()
    await writeManifest(
      fixture.paths.linuxX64BetaManifest,
      VERSION,
      [
        {
          name: fixture.names.linuxX64Deb,
          content: fixture.contents.linuxX64Deb,
        },
        {
          name: fixture.names.linuxX64Rpm,
          content: fixture.contents.linuxX64Rpm,
        },
        {
          name: fixture.names.linuxX64Rpm,
          content: Buffer.from('conflicting Linux x64 RPM metadata'),
        },
      ],
      fixture.names.linuxX64Deb
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      `linux-x64/beta-linux.yml: duplicate manifest asset ${fixture.names.linuxX64Rpm} has conflicting metadata`
    )
  })

  it('rejects unknown macOS manifest assets', async () => {
    const fixture = await createFixture()
    const unknownName = 'Motrix-2.0.0-arm64.pkg'
    await writeManifest(
      fixture.paths.macArm64Manifest,
      VERSION,
      [
        {
          name: fixture.names.macArm64Zip,
          content: fixture.contents.macArm64Zip,
        },
        { name: unknownName, content: Buffer.from('unknown package') },
      ],
      fixture.names.macArm64Zip
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      `darwin-arm64/latest-mac.yml: files[] contains unexpected asset ${unknownName}`
    )
  })

  it('publishes beta manifests without creating stable channel metadata', async () => {
    const version = '2.1.0-beta.1'
    const fixture = await createFixture(version)
    for (const target of [
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
    ]) {
      const directory = path.join(
        fixture.input,
        `release-input-${target}`,
        'release'
      )
      for (const name of await readdir(directory)) {
        if (name.startsWith('latest') && name.endsWith('.yml')) {
          await unlink(path.join(directory, name))
        }
      }
    }

    const result = await assembleReleaseArtifacts({
      inputDirectory: fixture.input,
      outputDirectory: fixture.output,
      version,
      channel: 'beta',
    })

    expect(result.manifests.sort()).toEqual(
      [
        'beta.yml',
        'beta-mac.yml',
        'beta-linux.yml',
        'beta-linux-arm64.yml',
      ].sort()
    )
    expect(
      (await readdir(fixture.output)).some((name) => name.startsWith('latest'))
    ).toBe(false)
    await expect(
      verifyUpdateArtifacts({
        directory: fixture.output,
        version,
        channel: 'beta',
        requireAll: true,
      })
    ).resolves.toMatchObject({
      manifests: expect.arrayContaining(result.manifests),
    })
  })

  it('rejects malformed prerelease versions outside workflow preflight', async () => {
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: '.',
        outputDirectory: '.',
        version: '2.1.0-beta..1',
        channel: 'beta',
      })
    ).rejects.toThrow('release version must be strict SemVer')
  })

  it('requires every package format for every target', async () => {
    const fixture = await createFixture()
    await unlink(fixture.paths.linuxArm64Rpm)

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'linux-arm64: required release asset Motrix-2.0.0.aarch64.rpm is missing'
    )
  })

  it('requires one architecture-specific Flatpak companion per Linux target', async () => {
    const fixture = await createFixture()
    await unlink(fixture.paths.linuxX64Companion)

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'linux-x64: required release asset Motrix-Native-Host-2.0.0-linux-x64.tar.gz is missing'
    )
  })

  it('rejects a target manifest with a different version', async () => {
    const fixture = await createFixture()
    await writeManifest(
      fixture.paths.windowsManifest,
      '2.0.1',
      [
        {
          name: fixture.names.windowsExe,
          content: fixture.contents.windowsExe,
        },
      ],
      fixture.names.windowsExe
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow('version 2.0.1 does not match 2.0.0')
  })

  it('rejects the wrong architecture-specific manifest name', async () => {
    const fixture = await createFixture()
    await rename(
      fixture.paths.linuxArm64Manifest,
      path.join(
        path.dirname(fixture.paths.linuxArm64Manifest),
        'latest-linux.yml'
      )
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'unexpected update manifest latest-linux.yml; expected latest-linux-arm64.yml, beta-linux-arm64.yml'
    )
  })

  it('requires the arm64 marker used by the macOS updater', async () => {
    const fixture = await createFixture()
    const content = Buffer.from('macOS arm64 ZIP without architecture marker')
    const name = 'Motrix-2.0.0-ARM64.zip'
    await unlink(fixture.paths.macArm64Zip)
    await writeAsset(path.dirname(fixture.paths.macArm64Zip), name, content)
    await writeManifest(
      path.join(path.dirname(fixture.paths.macArm64Zip), 'latest-mac.yml'),
      VERSION,
      [{ name, content }],
      name
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(`unexpected release asset ${name}`)
  })

  it('rejects missing and unsafe manifest references', async () => {
    const missing = await createFixture()
    await unlink(missing.paths.windowsExe)
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: missing.input,
        outputDirectory: missing.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'required release asset Motrix-Setup-2.0.0.exe is missing'
    )

    const unsafe = await createFixture()
    const checksum = sha512(Buffer.from('unsafe'))
    await writeFile(
      unsafe.paths.windowsManifest,
      dump({
        version: VERSION,
        files: [
          {
            url: '../unsafe.exe',
            sha512: checksum,
            size: 6,
          },
        ],
        path: '../unsafe.exe',
        sha512: checksum,
      })
    )
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: unsafe.input,
        outputDirectory: unsafe.output,
        version: VERSION,
      })
    ).rejects.toThrow('files[0].url is not a safe name')
  })

  it('rejects release assets outside the exact target basename contract', async () => {
    const fixture = await createFixture()
    await writeFile(
      path.join(path.dirname(fixture.paths.windowsZip), 'Motrix-2.0.0.exe'),
      Buffer.from('unexpected executable')
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow('win32-x64: unexpected release asset Motrix-2.0.0.exe')
  })

  it('allows only blockmaps belonging to exact target assets', async () => {
    const accepted = await createFixture()
    const expectedBlockmap = `${accepted.names.macArm64Zip}.blockmap`
    await writeFile(
      path.join(path.dirname(accepted.paths.macArm64Zip), expectedBlockmap),
      'blockmap'
    )
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: accepted.input,
        outputDirectory: accepted.output,
        version: VERSION,
      })
    ).resolves.toMatchObject({
      assets: expect.arrayContaining([expectedBlockmap]),
    })

    const rejected = await createFixture()
    await writeFile(
      `${rejected.paths.linuxX64AppImage}.blockmap`,
      'orphaned AppImage blockmap'
    )
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: rejected.input,
        outputDirectory: rejected.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'linux-x64: unexpected release asset Motrix-2.0.0-x86_64.AppImage.blockmap'
    )

    const zsyncBlockmap = await createFixture()
    await writeFile(
      `${zsyncBlockmap.paths.linuxX64Zsync}.blockmap`,
      'orphaned zsync blockmap'
    )
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: zsyncBlockmap.input,
        outputDirectory: zsyncBlockmap.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'linux-x64: unexpected release asset Motrix-2.0.0-x86_64.AppImage.zsync.blockmap'
    )

    const companionBlockmap = await createFixture()
    await writeFile(
      `${companionBlockmap.paths.linuxX64Companion}.blockmap`,
      'Flatpak companion blockmap'
    )
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: companionBlockmap.input,
        outputDirectory: companionBlockmap.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'linux-x64: unexpected release asset Motrix-Native-Host-2.0.0-linux-x64.tar.gz.blockmap'
    )
  })

  it('flattens AppImage/zsync assets but keeps zsync out of updater manifests', async () => {
    const fixture = await createFixture()

    await assembleReleaseArtifacts({
      inputDirectory: fixture.input,
      outputDirectory: fixture.output,
      version: VERSION,
    })

    // Both architecture AppImages land in the output alongside deb/rpm.
    const output = await readdir(fixture.output)
    expect(output).toEqual(
      expect.arrayContaining([
        'Motrix-2.0.0-x86_64.AppImage',
        'Motrix-2.0.0-x86_64.AppImage.zsync',
        'Motrix-2.0.0-arm64.AppImage',
        'Motrix-2.0.0-arm64.AppImage.zsync',
      ])
    )

    // Each Linux updater manifest lists its architecture's AppImage.
    for (const [manifestName, appImage] of [
      ['latest-linux.yml', 'Motrix-2.0.0-x86_64.AppImage'],
      ['latest-linux-arm64.yml', 'Motrix-2.0.0-arm64.AppImage'],
    ] as const) {
      const manifest = load(
        await readFile(path.join(fixture.output, manifestName), 'utf8')
      ) as { files: Array<{ url: string }> }
      expect(manifest.files.map((file) => file.url)).toContain(appImage)
      expect(manifest.files.some((file) => file.url.endsWith('.zsync'))).toBe(
        false
      )
    }
  })

  it('requires a zsync sidecar for every Linux AppImage', async () => {
    const fixture = await createFixture()
    await unlink(fixture.paths.linuxX64Zsync)
    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(
      'required release asset Motrix-2.0.0-x86_64.AppImage.zsync is missing'
    )
  })

  it('rejects Linux artifacts swapped between x64 and arm64 inputs', async () => {
    const fixture = await createFixture()
    await rename(
      fixture.paths.linuxX64Deb,
      path.join(
        path.dirname(fixture.paths.linuxX64Deb),
        fixture.names.linuxArm64Deb
      )
    )
    await rename(
      fixture.paths.linuxArm64Deb,
      path.join(
        path.dirname(fixture.paths.linuxArm64Deb),
        fixture.names.linuxX64Deb
      )
    )

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow(/linux-x64: unexpected release asset .*arm64\.deb/)
  })

  it('normalizes Linux legacy metadata to the DEB updater asset', async () => {
    const fixture = await createFixture()
    await assembleReleaseArtifacts({
      inputDirectory: fixture.input,
      outputDirectory: fixture.output,
      version: VERSION,
    })

    const manifest = load(
      await readFile(path.join(fixture.output, 'latest-linux.yml'), 'utf8')
    ) as { path: string; sha512: string }
    expect(manifest.path).toBe(fixture.names.linuxX64Deb)
    expect(manifest.sha512).toBe(sha512(fixture.contents.linuxX64Deb))
  })

  it('does not delete or overwrite a non-empty output directory', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.output)
    const marker = path.join(fixture.output, 'keep.txt')
    await writeFile(marker, 'keep')

    await expect(
      assembleReleaseArtifacts({
        inputDirectory: fixture.input,
        outputDirectory: fixture.output,
        version: VERSION,
      })
    ).rejects.toThrow('must be empty')
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep')
  })
})

async function createFixture(version = VERSION) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-release-inputs-'))
  tempDirs.push(root)
  const input = path.join(root, 'input')
  const output = path.join(root, 'output')
  await mkdir(input)

  const names = {
    linuxArm64Deb: `Motrix_${version}_arm64.deb`,
    linuxArm64Companion: `Motrix-Native-Host-${version}-linux-arm64.tar.gz`,
    linuxArm64Rpm: `Motrix-${version}.aarch64.rpm`,
    linuxArm64AppImage: `Motrix-${version}-arm64.AppImage`,
    linuxArm64Zsync: `Motrix-${version}-arm64.AppImage.zsync`,
    linuxX64Deb: `Motrix_${version}_amd64.deb`,
    linuxX64Companion: `Motrix-Native-Host-${version}-linux-x64.tar.gz`,
    linuxX64Rpm: `Motrix-${version}.x86_64.rpm`,
    linuxX64AppImage: `Motrix-${version}-x86_64.AppImage`,
    linuxX64Zsync: `Motrix-${version}-x86_64.AppImage.zsync`,
    macArm64Dmg: `Motrix-${version}-arm64.dmg`,
    macArm64Zip: `Motrix-${version}-arm64.zip`,
    macX64Dmg: `Motrix-${version}-x64.dmg`,
    macX64Zip: `Motrix-${version}-x64.zip`,
    windowsExe: `Motrix-Setup-${version}.exe`,
  }
  const linuxArm64AppImageContent = Buffer.from('Linux arm64 AppImage')
  const linuxX64AppImageContent = Buffer.from('Linux x64 AppImage')
  const contents = {
    linuxArm64Deb: Buffer.from('Linux arm64 deb'),
    linuxArm64Companion: Buffer.from('Linux arm64 Flatpak companion'),
    linuxArm64Rpm: Buffer.from('Linux arm64 rpm'),
    linuxArm64AppImage: linuxArm64AppImageContent,
    linuxArm64Zsync: makeZsync(
      names.linuxArm64AppImage,
      linuxArm64AppImageContent
    ),
    linuxX64Deb: Buffer.from('Linux x64 deb'),
    linuxX64Companion: Buffer.from('Linux x64 Flatpak companion'),
    linuxX64Rpm: Buffer.from('Linux x64 rpm'),
    linuxX64AppImage: linuxX64AppImageContent,
    linuxX64Zsync: makeZsync(names.linuxX64AppImage, linuxX64AppImageContent),
    macArm64Dmg: Buffer.from('macOS arm64 DMG'),
    macArm64Zip: Buffer.from('macOS arm64 ZIP'),
    macX64Dmg: Buffer.from('macOS x64 DMG'),
    macX64Zip: Buffer.from('macOS x64 ZIP'),
    windowsExe: Buffer.from('Windows x64 installer'),
  }

  const darwinArm64 = await makeTarget(input, 'darwin-arm64')
  await writeAsset(darwinArm64, names.macArm64Dmg, contents.macArm64Dmg)
  const macArm64Zip = await writeAsset(
    darwinArm64,
    names.macArm64Zip,
    contents.macArm64Zip
  )
  const macArm64Manifest = path.join(darwinArm64, 'latest-mac.yml')
  await writeManifest(
    macArm64Manifest,
    version,
    [
      { name: names.macArm64Zip, content: contents.macArm64Zip },
      { name: names.macArm64Dmg, content: contents.macArm64Dmg },
      { name: names.macArm64Dmg, content: contents.macArm64Dmg },
    ],
    names.macArm64Zip
  )
  await writeManifest(
    path.join(darwinArm64, 'beta-mac.yml'),
    version,
    [
      { name: names.macArm64Zip, content: contents.macArm64Zip },
      { name: names.macArm64Dmg, content: contents.macArm64Dmg },
      { name: names.macArm64Dmg, content: contents.macArm64Dmg },
    ],
    names.macArm64Zip
  )

  const darwinX64 = await makeTarget(input, 'darwin-x64')
  await writeAsset(darwinX64, names.macX64Dmg, contents.macX64Dmg)
  await writeAsset(darwinX64, names.macX64Zip, contents.macX64Zip)
  await writeManifest(
    path.join(darwinX64, 'latest-mac.yml'),
    version,
    [
      { name: names.macX64Zip, content: contents.macX64Zip },
      { name: names.macX64Dmg, content: contents.macX64Dmg },
      { name: names.macX64Dmg, content: contents.macX64Dmg },
    ],
    names.macX64Zip
  )
  await writeManifest(
    path.join(darwinX64, 'beta-mac.yml'),
    version,
    [
      { name: names.macX64Zip, content: contents.macX64Zip },
      { name: names.macX64Dmg, content: contents.macX64Dmg },
      { name: names.macX64Dmg, content: contents.macX64Dmg },
    ],
    names.macX64Zip
  )

  const linuxX64 = await makeTarget(input, 'linux-x64')
  const linuxX64Deb = await writeAsset(
    linuxX64,
    names.linuxX64Deb,
    contents.linuxX64Deb
  )
  const linuxX64Companion = await writeAsset(
    linuxX64,
    names.linuxX64Companion,
    contents.linuxX64Companion
  )
  await writeAsset(linuxX64, names.linuxX64Rpm, contents.linuxX64Rpm)
  const linuxX64AppImage = await writeAsset(
    linuxX64,
    names.linuxX64AppImage,
    contents.linuxX64AppImage
  )
  const linuxX64Zsync = await writeAsset(
    linuxX64,
    names.linuxX64Zsync,
    contents.linuxX64Zsync
  )
  const linuxX64Manifest = path.join(linuxX64, 'latest-linux.yml')
  const linuxX64BetaManifest = path.join(linuxX64, 'beta-linux.yml')
  await writeManifest(
    linuxX64Manifest,
    version,
    [
      { name: names.linuxX64Deb, content: contents.linuxX64Deb },
      { name: names.linuxX64Rpm, content: contents.linuxX64Rpm },
      { name: names.linuxX64AppImage, content: contents.linuxX64AppImage },
      { name: names.linuxX64Rpm, content: contents.linuxX64Rpm },
    ],
    names.linuxX64AppImage
  )
  await writeManifest(
    linuxX64BetaManifest,
    version,
    [
      { name: names.linuxX64Deb, content: contents.linuxX64Deb },
      { name: names.linuxX64Rpm, content: contents.linuxX64Rpm },
      { name: names.linuxX64AppImage, content: contents.linuxX64AppImage },
      { name: names.linuxX64Rpm, content: contents.linuxX64Rpm },
    ],
    names.linuxX64AppImage
  )

  const linuxArm64 = await makeTarget(input, 'linux-arm64')
  const linuxArm64Deb = await writeAsset(
    linuxArm64,
    names.linuxArm64Deb,
    contents.linuxArm64Deb
  )
  const linuxArm64Rpm = await writeAsset(
    linuxArm64,
    names.linuxArm64Rpm,
    contents.linuxArm64Rpm
  )
  const linuxArm64Companion = await writeAsset(
    linuxArm64,
    names.linuxArm64Companion,
    contents.linuxArm64Companion
  )
  const linuxArm64AppImage = await writeAsset(
    linuxArm64,
    names.linuxArm64AppImage,
    contents.linuxArm64AppImage
  )
  const linuxArm64Zsync = await writeAsset(
    linuxArm64,
    names.linuxArm64Zsync,
    contents.linuxArm64Zsync
  )
  const linuxArm64Manifest = path.join(linuxArm64, 'latest-linux-arm64.yml')
  await writeManifest(
    linuxArm64Manifest,
    version,
    [
      { name: names.linuxArm64Deb, content: contents.linuxArm64Deb },
      { name: names.linuxArm64Rpm, content: contents.linuxArm64Rpm },
      { name: names.linuxArm64AppImage, content: contents.linuxArm64AppImage },
      { name: names.linuxArm64Rpm, content: contents.linuxArm64Rpm },
    ],
    names.linuxArm64AppImage
  )
  await writeManifest(
    path.join(linuxArm64, 'beta-linux-arm64.yml'),
    version,
    [
      { name: names.linuxArm64Deb, content: contents.linuxArm64Deb },
      { name: names.linuxArm64Rpm, content: contents.linuxArm64Rpm },
      { name: names.linuxArm64AppImage, content: contents.linuxArm64AppImage },
      { name: names.linuxArm64Rpm, content: contents.linuxArm64Rpm },
    ],
    names.linuxArm64AppImage
  )

  const windows = await makeTarget(input, 'win32-x64')
  await writeAsset(windows, names.windowsExe, contents.windowsExe)
  const windowsZip = await writeAsset(windows, `Motrix-${version}-win.zip`)
  const windowsManifest = path.join(windows, 'latest.yml')
  await writeManifest(
    windowsManifest,
    version,
    [{ name: names.windowsExe, content: contents.windowsExe }],
    names.windowsExe
  )
  await writeManifest(
    path.join(windows, 'beta.yml'),
    version,
    [{ name: names.windowsExe, content: contents.windowsExe }],
    names.windowsExe
  )

  return {
    contents,
    input,
    names,
    output,
    paths: {
      linuxArm64Deb: linuxArm64Deb.path,
      linuxArm64Companion: linuxArm64Companion.path,
      linuxArm64Manifest,
      linuxArm64Rpm: linuxArm64Rpm.path,
      linuxArm64AppImage: linuxArm64AppImage.path,
      linuxArm64Zsync: linuxArm64Zsync.path,
      linuxX64Deb: linuxX64Deb.path,
      linuxX64Companion: linuxX64Companion.path,
      linuxX64AppImage: linuxX64AppImage.path,
      linuxX64Zsync: linuxX64Zsync.path,
      linuxX64BetaManifest,
      linuxX64Manifest,
      macArm64Manifest,
      macArm64Zip: macArm64Zip.path,
      windowsExe: path.join(windows, names.windowsExe),
      windowsManifest,
      windowsZip: windowsZip.path,
    },
  }
}

async function makeTarget(input: string, target: string) {
  const directory = path.join(input, `release-input-${target}`, 'release')
  await mkdir(directory, { recursive: true })
  return directory
}

async function writeAsset(
  directory: string,
  name: string,
  content = Buffer.from(name)
) {
  const file = path.join(directory, name)
  await writeFile(file, content)
  return { content, path: file }
}

async function writeManifest(
  file: string,
  version: string,
  assets: Array<{ name: string; content: Buffer }>,
  legacyName: string
) {
  const legacy = assets.find((asset) => asset.name === legacyName)
  if (!legacy) throw new Error(`Missing legacy fixture ${legacyName}`)
  const checksum = sha512(legacy.content)
  await writeFile(
    file,
    dump({
      version,
      files: assets.map((asset) => ({
        url: asset.name,
        sha512: sha512(asset.content),
        size: asset.content.length,
      })),
      path: legacyName,
      sha512: checksum,
      releaseDate: '2026-07-31T00:00:00.000Z',
    })
  )
}

function sha512(content: Buffer) {
  return createHash('sha512').update(content).digest('base64')
}

function makeZsync(name: string, content: Buffer) {
  return Buffer.from(
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
