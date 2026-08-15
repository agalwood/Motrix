import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — build tooling is intentionally plain ESM.
import {
  verifyExtractedSnap,
  verifySnapArtifact,
} from '../../scripts/verify-snap-artifact.mjs'

const PERSONAL_FILES = [
  '$HOME/.config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json',
  '$HOME/.config/microsoft-edge/NativeMessagingHosts/app.motrix.bridge.json',
  '$HOME/.mozilla/native-messaging-hosts/app.motrix.bridge.json',
]

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

function metadata(arch: 'amd64' | 'arm64', version = '2.0.0') {
  return {
    name: 'motrix',
    version,
    base: 'core24',
    grade: 'stable',
    confinement: 'strict',
    assumes: ['snapd2.43', 'snapd2.46'],
    links: {
      website: ['https://motrix.app'],
      'source-code': ['https://github.com/agalwood/Motrix'],
      issues: ['https://github.com/agalwood/Motrix/issues'],
    },
    architectures: [arch],
    apps: {
      motrix: {
        command: 'app/motrix --no-sandbox',
        environment: {
          MOTRIX_BRIDGE_DATA_DIR: '$SNAP_USER_COMMON/bridge',
          TMPDIR: '$XDG_RUNTIME_DIR',
        },
        'command-chain': [
          'snap/command-chain/gpu-2404-wrapper',
          'snap/command-chain/desktop-launch',
        ],
        plugs: [
          'audio-playback',
          'browser-native-messaging',
          'browser-support',
          'desktop',
          'desktop-legacy',
          'gsettings',
          'home',
          'network',
          'network-bind',
          'opengl',
          'removable-media',
          'screen-inhibit-control',
          'unity7',
          'wayland',
          'x11',
        ],
      },
      'native-host': {
        command: 'app/resources/bin/motrix-native-host',
        environment: {
          MOTRIX_BRIDGE_DATA_DIR: '$SNAP_USER_COMMON/bridge',
        },
        plugs: ['desktop', 'network'],
      },
    },
    plugs: {
      'browser-support': {
        interface: 'browser-support',
        'allow-sandbox': false,
      },
      'browser-native-messaging': {
        interface: 'personal-files',
        write: [...PERSONAL_FILES],
      },
      desktop: {
        'mount-host-font-cache': false,
      },
      'gnome-46-2404': {
        interface: 'content',
        target: '$SNAP/gnome-platform',
        'default-provider': 'gnome-46-2404',
      },
      'gpu-2404': {
        interface: 'content',
        target: '$SNAP/gpu-2404',
        'default-provider': 'mesa-2404',
      },
      'gtk-3-themes': {
        interface: 'content',
        target: '$SNAP/data-dir/themes',
        'default-provider': 'gtk-common-themes',
      },
      'icon-themes': {
        interface: 'content',
        target: '$SNAP/data-dir/icons',
        'default-provider': 'gtk-common-themes',
      },
      'sound-themes': {
        interface: 'content',
        target: '$SNAP/data-dir/sounds',
        'default-provider': 'gtk-common-themes',
      },
    },
    environment: {
      SNAP_DESKTOP_RUNTIME: '$SNAP/gnome-platform',
      GTK_USE_PORTAL: '1',
    },
  }
}

async function writeFixture(
  root: string,
  arch: 'amd64' | 'arm64',
  document = metadata(arch)
) {
  await mkdir(path.join(root, 'meta', 'gui'), { recursive: true })
  await writeFile(path.join(root, 'meta', 'snap.yaml'), dump(document))
  await writeFile(
    path.join(root, 'meta', 'gui', 'motrix.desktop'),
    [
      '[Desktop Entry]',
      'Exec=motrix %U',
      `Icon=\${SNAP}/meta/gui/icon.png`,
      'Terminal=false',
      'Type=Application',
      'MimeType=application/x-bittorrent;x-scheme-handler/magnet;x-scheme-handler/motrix;',
    ].join('\n')
  )
  await writeFile(path.join(root, 'meta', 'gui', 'icon.png'), 'png')
  await writeElf(path.join(root, 'app', 'motrix'), arch)
  await writeElf(
    path.join(root, 'app', 'resources', 'bin', 'motrix-native-host'),
    arch
  )
  await writeElf(
    path.join(
      root,
      'app',
      'resources',
      'extra',
      'linux',
      arch === 'amd64' ? 'x64' : 'arm64',
      'aria2c'
    ),
    arch
  )
  const resources = path.join(root, 'app', 'resources')
  for (const relativePath of [
    'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_NOTICES.zh-CN.md',
    path.join('THIRD_PARTY_LICENSES', 'aria2-COPYING'),
    path.join('legal', 'THIRD_PARTY_DEPENDENCIES.md'),
    path.join('legal', 'THIRD_PARTY_LICENSES.txt'),
    path.join('legal', 'sbom.spdx.json'),
  ]) {
    const filePath = path.join(resources, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'fixture')
  }
}

describe('verify-snap-artifact', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'motrix-snap-artifact-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const arch of ['amd64', 'arm64'] as const) {
    it(`accepts a complete ${arch} artifact`, async () => {
      await writeFixture(root, arch)
      await expect(
        verifyExtractedSnap({ root, arch, version: '2.0.0' })
      ).resolves.toEqual({ arch, version: '2.0.0' })
    })
  }

  it('rejects an artifact without the generated SPDX SBOM', async () => {
    await writeFixture(root, 'amd64')
    await rm(path.join(root, 'app', 'resources', 'legal', 'sbom.spdx.json'))

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/SPDX SBOM is missing/)
  })

  it('rejects additional personal-files write access', async () => {
    const document = metadata('amd64')
    document.plugs['browser-native-messaging'].write.push('$HOME/.ssh/config')
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/approved path set/)
  })

  it('rejects a sandboxed Electron command without --no-sandbox', async () => {
    const document = metadata('amd64')
    document.apps.motrix.command = 'app/motrix'
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.motrix\.command/)
  })

  it('requires the snapd version that provides SNAP_REAL_HOME', async () => {
    const document = metadata('amd64')
    document.assumes = ['snapd2.43']
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/snapd2\.46.*SNAP_REAL_HOME/)
  })

  it('requires Snapcraft 9 normalized project links', async () => {
    const document = metadata('amd64')
    document.links['source-code'] = ['https://example.invalid/source']
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/snap links\.source-code/)
  })

  it('requires the GNOME and GPU launch wrappers', async () => {
    const document = metadata('amd64')
    document.apps.motrix['command-chain'] = [
      'snap/command-chain/desktop-launch',
    ]
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.motrix\.command-chain/)
  })

  it('requires the reviewed launch-wrapper order', async () => {
    const document = metadata('amd64')
    document.apps.motrix['command-chain'].reverse()
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.motrix\.command-chain.*approved order/)
  })

  it('requires the reviewed content provider mount targets', async () => {
    const document = metadata('amd64')
    document.plugs['gpu-2404'].target = '$SNAP/unreviewed-gpu-target'
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/plugs\.gpu-2404\.target/)
  })

  it('rejects chrome-sandbox anywhere in the artifact', async () => {
    await writeFixture(root, 'amd64')
    await writeElf(path.join(root, 'app', 'chrome-sandbox'), 'amd64')

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/must not contain chrome-sandbox/)
  })

  it('rejects electron-updater metadata', async () => {
    await writeFixture(root, 'amd64')
    await writeFile(
      path.join(root, 'app', 'resources', 'app-update.yml'),
      'provider: generic'
    )

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/must not contain electron-updater metadata/)
  })

  it('rejects a native host for the wrong architecture', async () => {
    await writeFixture(root, 'amd64')
    await writeElf(
      path.join(root, 'app', 'resources', 'bin', 'motrix-native-host'),
      'arm64'
    )

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/native-host executable has the wrong ELF architecture/)
  })

  it('rejects extra native-host privileges', async () => {
    const document = metadata('amd64')
    document.apps['native-host'].plugs.push('home')
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.native-host\.plugs/)
  })

  it('rejects native-host launch wrappers that can pollute stdout', async () => {
    const document = metadata('amd64')
    Object.assign(document.apps['native-host'], {
      'command-chain': ['snap/command-chain/desktop-launch'],
    })
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.native-host.*pollute stdout/)
  })

  it('rejects unknown GUI privileges', async () => {
    const document = metadata('amd64')
    document.apps.motrix.plugs.push('snapd-control')
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/apps\.motrix\.plugs/)
  })

  it('rejects unknown root-level plugs', async () => {
    const document = metadata('amd64')
    document.plugs['host-files'] = {
      interface: 'system-files',
    }
    await writeFixture(root, 'amd64', document)

    await expect(
      verifyExtractedSnap({ root, arch: 'amd64', version: '2.0.0' })
    ).rejects.toThrow(/root plug names/)
  })

  it('reports a missing absolute unsquashfs executable clearly', async () => {
    const snapPath = path.join(root, 'motrix.snap')
    await writeFile(snapPath, 'not-reached')

    await expect(
      verifySnapArtifact({
        snapPath,
        arch: 'amd64',
        version: '2.0.0',
        unsquashfsPath: path.join(root, 'missing-unsquashfs'),
      })
    ).rejects.toThrow(/Failed to extract Snap with unsquashfs:.*ENOENT/)
  })
})
