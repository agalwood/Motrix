// Task 10 (Plan B, final) — end-to-end builtin update chain, NO IPC. Wires
// the composed chain from Tasks 2-7: a fixture seed dir + `PluginRegistry`
// (injected test pubkeys) + `BuiltinUpdater` (injected fetch + pubkeys) +
// `scanForUpdates`, proving the full hot-update / revert / downgrade-refusal
// story at the core level exactly as `main/ipc` handlers would drive it,
// minus IPC.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate } from '@core/session/migrations'
import type { PluginManifest } from '@shared/types/plugin'
import { builtinManifest, entryOf, keypair, moextOf } from '@test-utils/moext'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginRegistry } from '../plugin-registry'
import { scanForUpdates } from '../registry/update-scan'
import { PluginStateStore } from '../state/plugin-state-store'
import { BuiltinUpdater } from './builtin-updater'

const BUILTIN_ID = 'motrix.url-resolver'

function plantSeed(builtinDir: string, version: string): void {
  const dir = path.join(builtinDir, BUILTIN_ID)
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  writeFileSync(path.join(dir, 'motrix-plugin.json'), builtinManifest(version))
  writeFileSync(path.join(dir, 'dist', 'plugin.js'), `exports.v='${version}'`)
}

function fetchImplOf(bytes: Buffer): typeof fetch {
  return async () =>
    new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })
}

// ---------------------------------------------------------------------------

describe('e2e: builtin update chain (no IPC)', () => {
  let dir: string
  let builtinDir: string
  let overlayDir: string
  let pluginsDir: string
  let store: PluginStateStore
  let trusted: ReturnType<typeof keypair>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mreg-e2e-builtin-'))
    builtinDir = path.join(dir, 'builtin')
    overlayDir = path.join(dir, 'overlay')
    pluginsDir = path.join(dir, 'community')
    mkdirSync(builtinDir, { recursive: true })
    mkdirSync(overlayDir, { recursive: true })
    mkdirSync(pluginsDir, { recursive: true })
    const db = new Database(':memory:')
    migrate(db)
    store = new PluginStateStore(db)
    trusted = keypair()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRegistry(): PluginRegistry {
    return new PluginRegistry({
      pluginsDir,
      builtinDir,
      overlayDir,
      stateStore: store,
      hostVersion: '2.5.0',
      signingPubkeys: [trusted.pem],
    })
  }

  function makeUpdater(fetchImpl: typeof fetch): BuiltinUpdater {
    return new BuiltinUpdater({
      overlayDir,
      hostVersion: '2.5.0',
      pubkeys: [trusted.pem],
      fetchImpl,
    })
  }

  it('full chain: scan -> stage -> commit hot-swaps the effective version, then the update disappears from the scan', async () => {
    // Seed the read-only builtin tree at 1.0.0 and discover it.
    plantSeed(builtinDir, '1.0.0')
    const registry = makeRegistry()
    await registry.discover()
    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')

    // A signed 1.1.0 registry entry is available.
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, trusted, '1.1.0')

    // scanForUpdates sees exactly one builtin-channel update.
    const updatesBefore = scanForUpdates(registry.list(), [entry])
    expect(updatesBefore).toEqual([
      {
        pluginId: BUILTIN_ID,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        channel: 'builtin',
      },
    ])

    // Stage against the currently-effective manifest, then commit.
    const effectiveManifest = registry.get(BUILTIN_ID)?.manifest as
      | PluginManifest
      | undefined
    expect(effectiveManifest).toBeDefined()
    const updater = makeUpdater(fetchImplOf(bytes))
    const staged = await updater.stage(
      entry,
      effectiveManifest as PluginManifest
    )
    expect(staged.trustChanged).toBe(false)
    expect(staged.newVersion).toBe('1.1.0')

    const { pluginId } = await updater.commit(staged.stagingId)
    expect(pluginId).toBe(BUILTIN_ID)

    // Re-discover: the overlay is now effective.
    await registry.discover()
    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.1.0')
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin-update')

    // The same entry no longer shows up as an available update.
    expect(scanForUpdates(registry.list(), [entry])).toEqual([])
  })

  it('revert equivalence: deleting the overlay entry falls back to the bundled seed (what RevertBuiltinToBundled does minus IPC)', async () => {
    plantSeed(builtinDir, '1.0.0')
    const registry = makeRegistry()
    await registry.discover()
    const effectiveManifest = registry.get(BUILTIN_ID)
      ?.manifest as PluginManifest

    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, trusted, '1.1.0')
    const updater = makeUpdater(fetchImplOf(bytes))
    const staged = await updater.stage(entry, effectiveManifest)
    await updater.commit(staged.stagingId)

    await registry.discover()
    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.1.0')
    const overlayEntryDir = path.join(overlayDir, BUILTIN_ID)
    expect(existsSync(overlayEntryDir)).toBe(true)

    // Revert: remove the overlay entry directory outright.
    rmSync(overlayEntryDir, { recursive: true, force: true })

    await registry.discover()
    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin')
  })

  it('downgrade refusal: staging an older entry against a 1.1.0 overlay rejects builtin_not_newer (roll-forward-only)', async () => {
    plantSeed(builtinDir, '1.0.0')
    const registry = makeRegistry()
    await registry.discover()
    const effectiveV1 = registry.get(BUILTIN_ID)?.manifest as PluginManifest

    const v11Bytes = moextOf('1.1.0')
    const v11Entry = entryOf(v11Bytes, trusted, '1.1.0')
    const updater1 = makeUpdater(fetchImplOf(v11Bytes))
    const staged1 = await updater1.stage(v11Entry, effectiveV1)
    await updater1.commit(staged1.stagingId)

    await registry.discover()
    const effectiveV11 = registry.get(BUILTIN_ID)?.manifest as PluginManifest
    expect(effectiveV11.version).toBe('1.1.0')

    // Attempt to stage a 1.0.5 entry (older than the current 1.1.0 overlay).
    const downgradeBytes = moextOf('1.0.5')
    const downgradeEntry = entryOf(downgradeBytes, trusted, '1.0.5')
    const updater2 = makeUpdater(fetchImplOf(downgradeBytes))

    await expect(updater2.stage(downgradeEntry, effectiveV11)).rejects.toThrow(
      /builtin_not_newer/
    )

    // The 1.1.0 overlay is untouched by the rejected staging attempt.
    await registry.discover()
    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.1.0')
  })
})
