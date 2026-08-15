import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — build tooling is intentionally plain ESM.
import { prepareSnapProject } from '../../scripts/prepare-snap-project.mjs'

const REPOSITORY_ROOT = process.cwd()

async function writeElf(filePath: string, arch: 'amd64' | 'arm64') {
  const header = Buffer.alloc(20)
  header.set([0x7f, 0x45, 0x4c, 0x46])
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, Buffer.concat([header, Buffer.from('fixture')]))
  await chmod(filePath, 0o755)
}

describe('prepare-snap-project', () => {
  let projectDir: string
  let appDir: string
  let outputDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'motrix-snap-project-'))
    appDir = path.join(projectDir, 'release', 'linux-unpacked')
    outputDir = path.join(projectDir, 'release', 'snap-amd64')

    await mkdir(path.join(projectDir, 'build', 'snap', 'gui'), {
      recursive: true,
    })
    await copyFile(
      path.join(REPOSITORY_ROOT, 'build', 'snap', 'snapcraft.yaml.in'),
      path.join(projectDir, 'build', 'snap', 'snapcraft.yaml.in')
    )
    await copyFile(
      path.join(REPOSITORY_ROOT, 'build', 'snap', 'gui', 'motrix.desktop'),
      path.join(projectDir, 'build', 'snap', 'gui', 'motrix.desktop')
    )
    await copyFile(
      path.join(REPOSITORY_ROOT, 'build', '256x256.png'),
      path.join(projectDir, 'build', '256x256.png')
    )

    await writeElf(path.join(appDir, 'motrix'), 'amd64')
    await writeElf(
      path.join(appDir, 'resources', 'bin', 'motrix-native-host'),
      'amd64'
    )
    await writeElf(
      path.join(appDir, 'resources', 'extra', 'linux', 'x64', 'aria2c'),
      'amd64'
    )
    await writeFile(
      path.join(appDir, 'resources', 'app-update.yml'),
      'provider: generic'
    )
    await writeElf(path.join(appDir, 'chrome-sandbox'), 'amd64')
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('stages a strict single-architecture core24 project', async () => {
    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'amd64',
        version: '2.0.0',
      })
    ).resolves.toMatchObject({
      arch: 'amd64',
      electronArch: 'x64',
      outputDir,
      version: '2.0.0',
    })

    const yaml = load(
      await readFile(path.join(outputDir, 'snap', 'snapcraft.yaml'), 'utf8')
    ) as Record<string, any>
    expect(yaml).toMatchObject({
      name: 'motrix',
      version: '2.0.0',
      base: 'core24',
      confinement: 'strict',
      grade: 'stable',
      assumes: ['snapd2.46'],
      'source-code': 'https://github.com/agalwood/Motrix',
      issues: 'https://github.com/agalwood/Motrix/issues',
      platforms: {
        amd64: {
          'build-on': ['amd64'],
          'build-for': ['amd64'],
        },
      },
    })
    expect(yaml.apps.motrix.command).toBe('app/motrix --no-sandbox')
    expect(yaml.apps['native-host'].command).toBe(
      'app/resources/bin/motrix-native-host'
    )
    expect(yaml.parts.motrix.plugin).toBe('nil')
    expect(yaml.parts.motrix['override-build']).toContain(
      '$CRAFT_PART_INSTALL/app'
    )
    expect(yaml.parts.motrix.organize).toBeUndefined()
    expect(yaml.apps.motrix.plugs).toEqual([
      'audio-playback',
      'browser-native-messaging',
      'browser-support',
      'home',
      'network',
      'network-bind',
      'removable-media',
      'screen-inhibit-control',
      'unity7',
    ])
    expect(yaml.apps.motrix.extensions).toEqual(['gnome'])
    expect(yaml.apps['native-host'].plugs).toEqual(['desktop', 'network'])
    expect(yaml.plugs).toEqual({
      'browser-support': {
        interface: 'browser-support',
        'allow-sandbox': false,
      },
      'browser-native-messaging': {
        interface: 'personal-files',
        write: [
          '$HOME/.config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json',
          '$HOME/.config/microsoft-edge/NativeMessagingHosts/app.motrix.bridge.json',
          '$HOME/.mozilla/native-messaging-hosts/app.motrix.bridge.json',
        ],
      },
    })
    await expect(
      readFile(path.join(outputDir, 'app', 'chrome-sandbox'))
    ).rejects.toThrow()
    await expect(
      readFile(path.join(outputDir, 'app', 'resources', 'app-update.yml'))
    ).rejects.toThrow()
  })

  it('maps the arm64 Snap platform to the arm64 Electron payload', async () => {
    await rm(appDir, { recursive: true, force: true })
    outputDir = path.join(projectDir, 'release', 'snap-arm64')
    await writeElf(path.join(appDir, 'motrix'), 'arm64')
    await writeElf(
      path.join(appDir, 'resources', 'bin', 'motrix-native-host'),
      'arm64'
    )
    await writeElf(
      path.join(appDir, 'resources', 'extra', 'linux', 'arm64', 'aria2c'),
      'arm64'
    )

    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'arm64',
        version: '2.0.0',
      })
    ).resolves.toMatchObject({
      arch: 'arm64',
      electronArch: 'arm64',
    })

    const yaml = load(
      await readFile(path.join(outputDir, 'snap', 'snapcraft.yaml'), 'utf8')
    ) as Record<string, any>
    expect(yaml.platforms).toEqual({
      arm64: {
        'build-on': ['arm64'],
        'build-for': ['arm64'],
      },
    })
  })

  it('keeps Snap builds out of the electron-builder target set', async () => {
    const config = JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, 'electron-builder.json'),
        'utf8'
      )
    )
    expect(config.snap).toBeUndefined()
    expect(
      config.linux.target.map((target: { target: string }) => target.target)
    ).not.toContain('snap')
  })

  it('rejects an output directory outside release', async () => {
    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir: path.join(projectDir, 'snap-output'),
        arch: 'amd64',
        version: '2.0.0',
      })
    ).rejects.toThrow(/Output directory must be inside/)
  })

  it('rejects an invalid version before writing output', async () => {
    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'amd64',
        version: "2.0.0'\nconfinement: devmode",
      })
    ).rejects.toThrow(/strict SemVer/)
  })

  it('rejects a numeric prerelease identifier with a leading zero', async () => {
    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'amd64',
        version: '2.0.0-01',
      })
    ).rejects.toThrow(/strict SemVer/)
  })

  it('rejects a binary for the wrong architecture', async () => {
    await writeElf(
      path.join(appDir, 'resources', 'bin', 'motrix-native-host'),
      'arm64'
    )

    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'amd64',
        version: '2.0.0',
      })
    ).rejects.toThrow(/native-host executable is not an ELF64 binary/)
  })

  it('rejects a non-executable bundled binary', async () => {
    await chmod(
      path.join(appDir, 'resources', 'extra', 'linux', 'x64', 'aria2c'),
      0o644
    )

    await expect(
      prepareSnapProject({
        projectDir,
        appDir,
        outputDir,
        arch: 'amd64',
        version: '2.0.0',
      })
    ).rejects.toThrow(/aria2 executable is not executable/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an app payload symlink that escapes the source tree',
    async () => {
      const outside = path.join(projectDir, 'outside-payload')
      await writeFile(outside, 'outside')
      await symlink(outside, path.join(appDir, 'unsafe-link'))

      await expect(
        prepareSnapProject({
          projectDir,
          appDir,
          outputDir,
          arch: 'amd64',
          version: '2.0.0',
        })
      ).rejects.toThrow(/unsafe symlink/)
    }
  )
})
