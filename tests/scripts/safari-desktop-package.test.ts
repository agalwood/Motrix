import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- release signing hook is JavaScript
import { safariSignOptions } from '../../scripts/sign-macos.mjs'

describe('Safari desktop distribution', () => {
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
