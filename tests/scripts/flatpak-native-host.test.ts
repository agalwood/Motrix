import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface FlatpakSource {
  type?: string
  'dest-filename'?: string
}

interface FlatpakModule {
  name: string
  'build-commands'?: string[]
  sources?: FlatpakSource[]
}

interface FlatpakManifest {
  'finish-args': string[]
  modules: FlatpakModule[]
}

const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => FlatpakManifest
const root = process.cwd()
const manifest = parseYaml(
  readFileSync(path.join(root, 'flatpak/app.motrix.native.yml'), 'utf8')
)
const workflow = readFileSync(
  path.join(root, '.github/workflows/flatpak.yml'),
  'utf8'
)
const motrix = manifest.modules.find((module) => module.name === 'motrix')
const commands = motrix?.['build-commands']?.join('\n') ?? ''

describe('Flatpak native-host boundary', () => {
  it('exports only the private broker and installs no browser manifests', () => {
    expect(commands).toContain(
      '$FLATPAK_DEST/libexec/motrix-native-host-broker'
    )
    expect(commands).toContain('$FLATPAK_DEST/bin/motrix-native-host-broker')
    expect(commands).not.toMatch(
      /\$FLATPAK_DEST\/(?:bin|libexec)\/motrix-native-host(?:\s|$)/m
    )
    expect(commands).not.toMatch(
      /NativeMessagingHosts|native-messaging-hosts|\.mozilla\/native-messaging/i
    )

    const remove = commands.indexOf(
      'rm "$unpacked/resources/bin/motrix-native-host"'
    )
    const copy = commands.indexOf('cp -a "$unpacked" "$FLATPAK_DEST/motrix"')
    expect(remove).toBeGreaterThanOrEqual(0)
    expect(copy).toBeGreaterThan(remove)
    expect(
      motrix?.sources?.find(
        (source) => source['dest-filename'] === 'native-host-flatpak.sh'
      )
    ).toBeUndefined()
    const brokerWrapper = motrix?.sources?.find(
      (source) => source['dest-filename'] === 'native-host-broker-flatpak.sh'
    ) as (FlatpakSource & { commands?: string[] }) | undefined
    expect(brokerWrapper?.commands?.join('\n')).toContain(
      'exec /app/libexec/motrix-native-host-broker'
    )
    expect(brokerWrapper?.commands?.join('\n')).not.toContain(
      'MOTRIX_BRIDGE_DATA_DIR'
    )
  })

  it('does not grant Motrix a host escape or native-messaging proxy', () => {
    expect(manifest['finish-args']).not.toContain('--socket=session-bus')
    expect(manifest['finish-args']).not.toContain('--socket=system-bus')
    expect(manifest['finish-args'].join('\n')).not.toMatch(
      /org\.freedesktop\.(?:Flatpak|NativeMessagingProxy)|flatpak-spawn/
    )
  })

  it('pins the broker v1 frame independently from Browser Native Messaging', () => {
    const payload = Buffer.from('{"operation":"probe"}')
    const header = Buffer.alloc(12)
    header.write('MXBR', 0, 'ascii')
    header.writeUInt32LE(1, 4)
    header.writeUInt32LE(payload.length, 8)
    const frame = Buffer.concat([header, payload])

    expect(frame.subarray(0, 4).toString('ascii')).toBe('MXBR')
    expect(frame.readUInt32LE(4)).toBe(1)
    expect(frame.readUInt32LE(8)).toBe(payload.length)
    expect(workflow).toContain('--command=motrix-native-host-broker')
    expect(workflow).toContain('-name "motrix-flatpak-native-host"')
    expect(workflow).toContain(
      '4d584252010000001e0000007b226572726f72223a226d6f747269782d6e6f742d72756e6e696e67227d'
    )
  })

  it('runs the x86_64 companion through the installed Flatpak', () => {
    expect(workflow).toContain('targets: x86_64-unknown-linux-musl')
    expect(workflow).toContain(
      'node packages/native-host/build.mjs --platform linux --arch x64'
    )
    expect(workflow).toContain('Motrix-Native-Host-0.0.0-ci-linux-x64.tar.gz')
    expect(workflow).toContain(
      'node packages/native-host/package-flatpak-companion.mjs'
    )
    expect(workflow).toContain('--strip-components=1')
    expect(workflow).toContain(
      '"$archive_companion" install --flatpak-bin "$flatpak_bin"'
    )
    expect(workflow).toContain('"$installed_companion" status')
    expect(workflow).toContain('"$installed_companion" uninstall')
    expect(workflow).toContain(
      `bridge_dir="\${XDG_CONFIG_HOME:?}/motrix/bridge"`
    )
    expect(workflow).toContain(
      'chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/'
    )
    expect(workflow).toContain("self.path != '/discovery'")
    expect(workflow).toContain("self.path != '/nonce'")
    expect(workflow).toContain("self.headers.get('X-Motrix-Bridge') != '1'")
    expect(workflow).toContain(
      '5a0000007b22616374696f6e223a227265717565737450616972222c2270726f746f636f6c56657273696f6e223a312c22706f7274223a35353830392c226e6f6e6365223a224162436445664768496a4b6c4d6e4f70517253745576227d'
    )
  })
})
