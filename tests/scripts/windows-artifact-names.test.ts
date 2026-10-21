import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  configureWindowsArtifactNames,
  windowsArtifactNamePatterns,
} from '../../scripts/windows-artifact-names.mjs'

const require = createRequire(import.meta.url)
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)

async function resolveConfiguredWindowsTargets(
  configPath: string,
  cliOptions: { win: string[]; x64?: boolean; arm64?: boolean }
) {
  require('app-builder-lib')
  const { Platform } = require('app-builder-lib')
  const { WinPackager } = require('app-builder-lib/out/winPackager')
  const { normalizeOptions } = require('electron-builder/out/builder')
  const {
    computeArchToTargetNamesMap,
  } = require('app-builder-lib/out/targets/targetFactory')
  const config = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, configPath), 'utf8')
  )
  const packager = new WinPackager({
    config,
    metadata: { name: 'motrix', version: '2.0.0-beta.52' },
  })
  const options = normalizeOptions(cliOptions)
  return computeArchToTargetNamesMap(
    options.targets.get(Platform.WINDOWS),
    packager,
    Platform.WINDOWS
  )
}

describe.each(['electron-builder.json', 'electron-builder.signing.json'])(
  '%s Windows architecture selection',
  (configPath) => {
    it.each([
      ['x64', false],
      ['arm64', false],
      ['x64', true],
      ['arm64', true],
    ])('selects only %s with explicit targets=%s', async (arch, explicit) => {
      const { Arch } = require('builder-util')
      const actual = await resolveConfiguredWindowsTargets(configPath, {
        win: explicit ? ['nsis', 'zip'] : [],
        [arch]: true,
      })
      expect([...actual]).toEqual([[Arch[arch], ['nsis', 'zip']]])
    })

    it('inherits the host architecture when no CLI architecture is selected', async () => {
      const { Arch } = require('builder-util')
      const actual = await resolveConfiguredWindowsTargets(configPath, {
        win: [],
      })
      expect([...actual]).toEqual([[Arch[process.arch], ['nsis', 'zip']]])
    })
  }
)

describe('Windows artifact names', () => {
  it('retains the existing x64 URLs and distinguishes ARM64 downloads', () => {
    expect(windowsArtifactNamePatterns('x64')).toEqual({
      nsis: `\${productName}-Setup-\${version}.\${ext}`,
      zip: `\${productName}-\${version}-win.\${ext}`,
    })
    expect(windowsArtifactNamePatterns('arm64')).toEqual({
      nsis: `\${productName}-Setup-\${version}-arm64.\${ext}`,
      zip: `\${productName}-\${version}-win-arm64.\${ext}`,
    })
    expect(() => windowsArtifactNamePatterns('ia32')).toThrow(
      'unsupported Windows artifact architecture'
    )
  })

  it('updates constructed targets without changing shared builder options', () => {
    const sharedOptions = { artifactName: 'custom.exe', oneClick: false }
    const targets = [
      { name: 'nsis', options: sharedOptions },
      { name: 'zip', options: undefined },
      { name: 'dir', options: undefined },
    ]
    configureWindowsArtifactNames(targets, 'arm64')

    expect(targets[0].options).toEqual({
      artifactName: `\${productName}-Setup-\${version}-arm64.\${ext}`,
      oneClick: false,
      buildUniversalInstaller: false,
    })
    expect(targets[1].options).toEqual({
      artifactName: `\${productName}-\${version}-win-arm64.\${ext}`,
    })
    expect(targets[2].options).toBeUndefined()
    expect(sharedOptions).toEqual({
      artifactName: 'custom.exe',
      oneClick: false,
    })

    configureWindowsArtifactNames(targets, 'x64')
    expect(targets[0].options?.artifactName).toBe(
      `\${productName}-Setup-\${version}.\${ext}`
    )
    expect(targets[1].options?.artifactName).toBe(
      `\${productName}-\${version}-win.\${ext}`
    )
  })

  it.each([
    ['x64', 1, ''],
    ['arm64', 3, '-arm64'],
  ])('configures real electron-builder %s targets', (arch, ordinal, suffix) => {
    // Initialize the entry point first because the builder platform modules
    // have circular dependencies. Exercise the installed pinned constructors,
    // including their resolved options, without invoking a native build.
    require('app-builder-lib')
    const { WinPackager } = require('app-builder-lib/out/winPackager')
    const {
      NsisTarget,
    } = require('app-builder-lib/out/targets/nsis/NsisTarget')
    const {
      ArchiveTarget,
    } = require('app-builder-lib/out/targets/ArchiveTarget')
    const {
      AppPackageHelper,
      CopyElevateHelper,
    } = require('app-builder-lib/out/targets/nsis/nsisUtil')
    const packager = new WinPackager({
      config: {
        productName: 'Motrix',
        win: {},
        nsis: { artifactName: 'legacy-installer.exe', oneClick: false },
      },
      metadata: { name: 'motrix', version: '2.0.0-beta.52' },
    })
    const nsis = new NsisTarget(
      packager,
      '/release',
      'nsis',
      new AppPackageHelper(new CopyElevateHelper())
    )
    const zip = new ArchiveTarget('zip', '/release', packager)

    expect(nsis.options).not.toBe(packager.config.nsis)
    expect(zip.options).toBeUndefined()
    configureWindowsArtifactNames([nsis, zip], arch)
    expect(nsis.shouldBuildUniversalInstaller).toBe(false)
    expect(nsis.options.oneClick).toBe(false)
    expect(
      packager.expandArtifactNamePattern(nsis.options, 'exe', ordinal)
    ).toBe(`Motrix-Setup-2.0.0-beta.52${suffix}.exe`)
    expect(
      packager.expandArtifactNamePattern(zip.options, 'zip', ordinal)
    ).toBe(`Motrix-2.0.0-beta.52-win${suffix}.zip`)
    expect(packager.config.nsis.artifactName).toBe('legacy-installer.exe')
    expect(packager.config.zip).toBeUndefined()
  })
})
