import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createWindowsStoreBuilderConfig } from '../../scripts/windows-store-builder-config.mjs'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)
const outputDirectory = path.join(repoRoot, 'release/windows-store/dir')
const readBase = async () =>
  JSON.parse(
    await readFile(path.join(repoRoot, 'electron-builder.json'), 'utf8')
  )

const require = createRequire(import.meta.url)
const {
  getConfig,
  validateConfiguration,
} = require('app-builder-lib/out/util/config/config.js')

describe('Windows Store directory builder configuration', () => {
  it('survives the installed builder config loader without restoring publishing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'motrix-store-config-'))
    try {
      const file = path.join(directory, 'builder.json')
      const generated = createWindowsStoreBuilderConfig(await readBase(), {
        outputDirectory,
      })
      await writeFile(file, JSON.stringify(generated))
      const loaded = await getConfig(repoRoot, file)
      await validateConfiguration(loaded, { isEnabled: false })

      expect(loaded.win.target).toEqual([{ target: 'dir', arch: ['x64'] }])
      expect(loaded.publish).toBeNull()
      expect(loaded.win.publish).toBeNull()
      expect(loaded.beforePack).toBe(generated.beforePack)
      expect(loaded.beforeBuild).toBe(generated.beforeBuild)
      expect(loaded.electronFuses).toEqual(generated.electronFuses)
      expect(loaded).not.toHaveProperty('nsis')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes NSIS targets and update publication without changing the base', async () => {
    const base = await readBase()
    const original = structuredClone(base)
    const config = createWindowsStoreBuilderConfig(base, { outputDirectory })

    expect(config.win.target).toEqual([{ target: 'dir', arch: ['x64'] }])
    expect(config.publish).toBeNull()
    expect(config.win.publish).toBeNull()
    expect(config.detectUpdateChannel).toBe(false)
    expect(config.generateUpdatesFilesForAllChannels).toBe(false)
    expect(config.forceCodeSigning).toBe(false)
    expect(config.win.signExecutable).toBe(false)
    expect(config).not.toHaveProperty('nsis')
    expect(config).not.toHaveProperty('artifactBuildCompleted')
    expect(config.extends).toBeNull()
    expect(config.directories.output).toBe(outputDirectory)
    expect(base).toEqual(original)
  })

  it('retains the staged payload, native resources, legal files, hooks, and fuses', async () => {
    const base = await readBase()
    const config = createWindowsStoreBuilderConfig(base, { outputDirectory })

    for (const key of [
      'appId',
      'productName',
      'asar',
      'asarUnpack',
      'files',
      'extraResources',
      'electronFuses',
      'beforePack',
      'beforeBuild',
    ]) {
      expect(config[key], key).toEqual(base[key])
    }
    expect(config.win.extraResources).toEqual([
      ...base.win.extraResources,
      {
        from: 'packages/windows-platform/dist/win32-x64/motrix-windows-platform.exe',
        to: 'bin/motrix-windows-platform.exe',
      },
    ])
    expect(config.win).not.toHaveProperty('signAndEditExecutable')
    expect(config.directories.app).toBe('dist/electron-app')
    expect(config.directories.buildResources).toBe(
      base.directories.buildResources
    )
    config.win.extraResources[0].from = 'changed'
    expect(base.win.extraResources[0].from).toBe('./extra/aria2.conf')
  })

  it('overrides a Windows-specific publisher as well as the global publisher', async () => {
    const base = await readBase()
    base.win.publish = {
      provider: 'generic',
      url: 'https://updates.example.invalid',
    }
    base.win.signExecutable = true
    const config = createWindowsStoreBuilderConfig(base, { outputDirectory })

    expect(config.win.publish).toBeNull()
    expect(config.win.signExecutable).toBe(false)
    expect(base.win.publish).toBeDefined()
  })

  it.each(['beforePack', 'beforeBuild'])(
    'rejects a replaced %s hook',
    async (hook) => {
      const base = await readBase()
      base[hook] = './scripts/other-hook.mjs'
      expect(() =>
        createWindowsStoreBuilderConfig(base, { outputDirectory })
      ).toThrow('staging hooks')
    }
  )

  it.each(['source-root', 'asar-disabled', 'resources-missing'])(
    'rejects unsafe payload configuration: %s',
    async (scenario) => {
      const base = await readBase()
      if (scenario === 'source-root') base.directories.app = '.'
      if (scenario === 'asar-disabled') base.asar = false
      if (scenario === 'resources-missing') delete base.win.extraResources
      expect(() =>
        createWindowsStoreBuilderConfig(base, { outputDirectory })
      ).toThrow()
    }
  )

  it.each(['', 'release/windows-store'])(
    'rejects an ambiguous output directory: %s',
    async (relative) => {
      const base = await readBase()
      expect(() =>
        createWindowsStoreBuilderConfig(base, { outputDirectory: relative })
      ).toThrow('absolute')
    }
  )
})
