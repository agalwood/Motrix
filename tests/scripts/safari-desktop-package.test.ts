import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- release signing hook is JavaScript
import {
  safariSignOptions,
  signSafariHelpers,
} from '../../scripts/sign-macos.mjs'

describe('Safari desktop distribution', () => {
  it('rejects helper signing without a selected identity', () => {
    expect(() =>
      signSafariHelpers({ app: '/missing.app' }, 'safari.plist')
    ).toThrow('requires the selected identity')
  })

  it.runIf(process.platform === 'darwin')(
    'signs unsigned x64 helpers before the main executable seals the app',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'motrix-sign-order-'))
      try {
        const app = path.join(root, 'Motrix.app')
        const macos = path.join(app, 'Contents/MacOS')
        const launch = path.join(app, 'Contents/Library/LaunchServices')
        mkdirSync(macos, { recursive: true })
        mkdirSync(launch, { recursive: true })
        writeFileSync(
          path.join(app, 'Contents/Info.plist'),
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.motrix.signing-test</string>
<key>CFBundleExecutable</key><string>Motrix</string>
<key>CFBundleName</key><string>Motrix</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`
        )
        const source = path.join(root, 'main.c')
        writeFileSync(source, 'int main(void) { return 0; }\n')
        for (const file of [
          path.join(macos, 'Motrix'),
          path.join(macos, 'MotrixSafariRegistrar'),
          path.join(launch, 'MotrixSafariBootstrap'),
        ]) {
          execFileSync('/usr/bin/xcrun', [
            'clang',
            '-target',
            'x86_64-apple-macos13.0',
            '-Wl,-no_adhoc_codesign',
            source,
            '-o',
            file,
          ])
        }
        const mainArguments = [
          '--force',
          '--sign',
          '-',
          '--timestamp=none',
          path.join(macos, 'Motrix'),
        ]
        const unsigned = spawnSync('/usr/bin/codesign', mainArguments, {
          encoding: 'utf8',
        })
        expect(unsigned.status).not.toBe(0)
        expect(unsigned.stderr).toContain('code object is not signed at all')
        signSafariHelpers(
          { app, identity: '-' },
          path.resolve('build/entitlements.safari.plist')
        )
        execFileSync('/usr/bin/codesign', mainArguments)
        // Ad-hoc fixtures prove the ordering without accessing certificates.
        // Deep verification of the Apple designated requirements stays in the
        // protected release path, using the selected Developer ID identity.
        for (const file of [
          path.join(macos, 'MotrixSafariRegistrar'),
          path.join(launch, 'MotrixSafariBootstrap'),
        ]) {
          execFileSync('/usr/bin/codesign', ['--verify', '--strict', file])
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    // Cold Xcode tool startup on CI can exceed the default five seconds.
    30_000
  )

  it('gives only the exact helper paths their dedicated entitlements and identifiers', () => {
    const app = '/Applications/Motrix.app'
    const fallback = () => ({
      entitlements: 'electron.plist',
      hardenedRuntime: true,
    })
    for (const [relative, identifier] of [
      [
        'Contents/MacOS/MotrixSafariRegistrar',
        'app.motrix.safari.registration',
      ],
      [
        'Contents/Library/LaunchServices/MotrixSafariBootstrap',
        'app.motrix.safari.bootstrap',
      ],
    ]) {
      const result = safariSignOptions(
        app,
        path.join(app, relative!),
        'safari.plist',
        fallback
      )
      expect(result.entitlements).toBe('safari.plist')
      expect(result.additionalArguments).toEqual(['--identifier', identifier])
      expect(result.requirements).toContain('7VMB56CA56')
      expect(result.hardenedRuntime).toBe(true)
    }
    for (const file of [
      app,
      `${app}/Contents/MacOS/Motrix`,
      '/tmp/MotrixSafariBootstrap',
      `${app}/Contents/Resources/MotrixSafariBootstrap`,
    ]) {
      expect(safariSignOptions(app, file, 'safari.plist', fallback)).toEqual(
        fallback()
      )
    }
  })

  it('gives unsigned and signed release builds the same per-attempt bundle version', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const versions = workflow.match(/-c\.mac\.bundleVersion=[^\r\n ]+/g)
    // Match complete expressions because GitHub expressions contain spaces.
    expect(versions).toHaveLength(2)
    expect(
      workflow.split(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
        '-c.mac.bundleVersion=${{ github.run_number }}.${{ github.run_attempt }}.0'
      )
    ).toHaveLength(3)
  })

  it('embeds desktop helpers in both unsigned and isolated signing packages', () => {
    for (const name of [
      'electron-builder.json',
      'electron-builder.signing.json',
    ]) {
      const config = JSON.parse(readFileSync(name, 'utf8'))
      expect(config.mac.sign).toBe('./scripts/sign-macos.mjs')
      expect(
        config.mac.extraFiles.map((file: { to: string }) => file.to)
      ).toEqual([
        'Library/LaunchServices/MotrixSafariBootstrap',
        'MacOS/MotrixSafariRegistrar',
        'Library/LaunchAgents/app.motrix.safari.bootstrap.plist',
      ])
    }
    for (const name of ['ci.yml', 'release.yml']) {
      const workflow = readFileSync(`.github/workflows/${name}`, 'utf8')
      expect(workflow).toContain(
        'swift test --package-path packages/safari-bootstrap'
      )
      expect(workflow).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
        'pnpm run build:safari-bootstrap -- --arch ${{ matrix.arch }} --test'
      )
    }
  })
})
