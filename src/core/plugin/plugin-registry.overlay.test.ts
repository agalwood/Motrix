// Task 6 (Plan B) — PluginRegistry overlay scan + arbitration. The overlay
// (<overlayDir>/<id>: extracted tree + bundle.moext + _overlay.json) is
// written by BuiltinUpdater (Task B5) into OS-writable userData. Origin
// 'builtin' is EARNED here by re-verifying bundle.moext against
// _overlay.json.signature and the pinned keys on every scan — never assumed
// from directory location. This file exercises the 7-case arbitration
// matrix from the design brief.

import { createHash } from 'node:crypto'
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
import { keypair, makeZip } from '@test-utils/moext'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginRegistry, type PluginRegistryOptions } from './plugin-registry'
import { PluginStateStore } from './state/plugin-state-store'

// ---------------------------------------------------------------------------
// Fixture helpers: seed (read-only builtin tree) and overlay (extracted tree
// + bundle.moext + _overlay.json, per BuiltinUpdater's commit() layout).
// ---------------------------------------------------------------------------

const BUILTIN_ID = 'motrix.url-resolver'

function builtinManifestJSON(
  id: string,
  version: string,
  over: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    manifestVersion: 1,
    id,
    name: `name-${id}`,
    version,
    description: 'd',
    categories: ['integration'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  })
}

function plantSeed(
  builtinDir: string,
  id: string,
  version: string,
  over: Record<string, unknown> = {}
): void {
  const dir = path.join(builtinDir, id)
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  writeFileSync(
    path.join(dir, 'motrix-plugin.json'),
    builtinManifestJSON(id, version, over)
  )
  writeFileSync(path.join(dir, 'dist', 'plugin.js'), `exports.v='${version}'`)
}

function plantCorruptSeed(builtinDir: string, id: string): void {
  const dir = path.join(builtinDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'motrix-plugin.json'), '{ broken json')
}

interface OverlayOpts {
  manifestOver?: Record<string, unknown>
  tamperBundle?: boolean
  skipOverlayJson?: boolean
  signer?: ReturnType<typeof keypair>
  packageUrl?: string
  recordedAt?: number
}

function tamperOneByte(buf: Buffer): Buffer {
  const copy = Buffer.from(buf)
  copy[0] = (copy[0] ^ 0xff) & 0xff
  return copy
}

/** Writes an overlay entry the same shape BuiltinUpdater.commit() produces:
 * extracted tree (motrix-plugin.json + dist/plugin.js) + bundle.moext (raw
 * package bytes) + _overlay.json ({packageUrl, sha256, signature, recordedAt}).
 */
function plantOverlay(
  overlayDir: string,
  id: string,
  version: string,
  trusted: ReturnType<typeof keypair>,
  opts: OverlayOpts = {}
): { packageUrl: string; recordedAt: number } {
  const dir = path.join(overlayDir, id)
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const manifestJSON = builtinManifestJSON(id, version, opts.manifestOver)
  writeFileSync(path.join(dir, 'motrix-plugin.json'), manifestJSON)
  writeFileSync(path.join(dir, 'dist', 'plugin.js'), `exports.v='${version}'`)

  const bundleBytes = makeZip([
    { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON) },
    { name: 'dist/plugin.js', data: Buffer.from(`exports.v='${version}'`) },
  ])
  const signer = opts.signer ?? trusted
  const signature = signer.sign(bundleBytes)
  const onDisk = opts.tamperBundle ? tamperOneByte(bundleBytes) : bundleBytes
  writeFileSync(path.join(dir, 'bundle.moext'), onDisk)

  const packageUrl = opts.packageUrl ?? `https://dl.motrix.app/p/${id}.moext`
  const recordedAt = opts.recordedAt ?? 1700000000000
  if (!opts.skipOverlayJson) {
    writeFileSync(
      path.join(dir, '_overlay.json'),
      JSON.stringify({
        version: 1,
        packageUrl,
        sha256: createHash('sha256').update(bundleBytes).digest('hex'),
        signature,
        recordedAt,
      })
    )
  }
  return { packageUrl, recordedAt }
}

// ---------------------------------------------------------------------------

describe('PluginRegistry overlay scan + arbitration', () => {
  let dir: string
  let builtinDir: string
  let overlayDir: string
  let pluginsDir: string
  let store: PluginStateStore
  let trusted: ReturnType<typeof keypair>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mreg-overlay-'))
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

  function makeRegistry(
    extra: Partial<PluginRegistryOptions> = {}
  ): PluginRegistry {
    return new PluginRegistry({
      pluginsDir,
      builtinDir,
      overlayDir,
      stateStore: store,
      hostVersion: '2.5.0',
      signingPubkeys: [trusted.pem],
      ...extra,
    })
  }

  it('1. verified overlay with a higher version wins; source becomes builtin-update', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    const { packageUrl } = plantOverlay(
      overlayDir,
      BUILTIN_ID,
      '1.1.0',
      trusted
    )

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.1.0')
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin-update')
    expect(dto?.source?.url).toBe(packageUrl)
    // overlay survives — it's the effective entry now
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(true)
  })

  it('2. tampered bundle.moext is dropped; seed 1.0.0 stays effective', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted, {
      tamperBundle: true,
    })

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)
  })

  it('3. missing _overlay.json is dropped; seed stays effective', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted, {
      skipOverlayJson: true,
    })

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)
  })

  it('4. seed >= overlay retires the overlay (equal version, then lower version)', async () => {
    // equal version — no update to earn, overlay is stale
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.0.0', trusted)

    const registryEqual = makeRegistry()
    await registryEqual.discover()
    expect(registryEqual.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)

    // lower version — an even staler overlay (e.g. left over from a builtin
    // downgrade/reinstall of the seed)
    plantOverlay(overlayDir, BUILTIN_ID, '0.9.0', trusted)
    const registryLower = makeRegistry()
    await registryLower.discover()
    expect(registryLower.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)
  })

  it('5. orphan overlay with no seed dir is deleted at scan', async () => {
    plantOverlay(overlayDir, 'motrix.orphan-tool', '1.0.0', trusted)

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get('motrix.orphan-tool')).toBeUndefined()
    expect(existsSync(path.join(overlayDir, 'motrix.orphan-tool'))).toBe(false)
  })

  it('6. overlay engines.motrix incompatible with hostVersion is ignored but kept', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted, {
      manifestOver: { engines: { motrix: '^99.0.0' } },
    })

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    // NOT deleted — a future host upgrade may satisfy engines.motrix
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(true)
  })

  it('8. _overlay.json containing literal `null` is dropped without crashing discover()', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted)
    // Overwrite the well-formed fixture with valid-but-useless JSON: `null`
    // parses successfully, so this exercises the shape guard rather than
    // the JSON.parse catch.
    writeFileSync(path.join(overlayDir, BUILTIN_ID, '_overlay.json'), 'null')

    const registry = makeRegistry()
    await expect(registry.discover()).resolves.toBeUndefined()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)
  })

  it('9. _overlay.json with wrong-shaped fields is dropped without crashing discover()', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted)
    writeFileSync(
      path.join(overlayDir, BUILTIN_ID, '_overlay.json'),
      JSON.stringify({ signature: 42 })
    )

    const registry = makeRegistry()
    await expect(registry.discover()).resolves.toBeUndefined()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.0.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(false)
  })

  it('7. corrupt seed manifest + verified overlay: overlay effective and NOT deleted', async () => {
    plantCorruptSeed(builtinDir, BUILTIN_ID)
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted)

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(BUILTIN_ID)?.manifest.version).toBe('1.1.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(true)
    // the corrupt seed itself still surfaces its own load error
    expect(
      registry.loadErrors().some((e) => e.pluginDir.endsWith(BUILTIN_ID))
    ).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Task 6 — Firefox packed-XPI read path (2026-07-18 design §4): the
  // manifest must come from the signature-verified bundle.moext, never the
  // separately-tamperable extracted tree. plantOverlay's bundle.moext is
  // built from the SAME manifestJSON/version it writes to the tree, so these
  // two cases hand-edit the tree's motrix-plugin.json AFTER the fact —
  // simulating an attacker (or just filesystem corruption) touching the tree
  // without re-signing anything — and assert the tree edit has zero effect.
  // -------------------------------------------------------------------------

  it('10. tree motrix-plugin.json tampered (different version) while bundle is valid: effective manifest matches the BUNDLE, tamper ignored', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted)

    // Tamper the tree's manifest in place: bump version and add a permission
    // the signed bundle never declared. The signature was computed over
    // bundle.moext only, so bundle.moext itself is untouched and still
    // verifies — but if the registry were still trusting the tree file, this
    // edit would silently take effect.
    writeFileSync(
      path.join(overlayDir, BUILTIN_ID, 'motrix-plugin.json'),
      builtinManifestJSON(BUILTIN_ID, '9.9.9', {
        permissions: ['ffmpeg'],
      })
    )

    const registry = makeRegistry()
    await registry.discover()

    const indexed = registry.get(BUILTIN_ID)
    expect(indexed?.manifest.version).toBe('1.1.0')
    expect(indexed?.manifest.permissions).toEqual([])
    // overlay survives — the tampered tree doesn't trip corruption handling
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(true)
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin-update')
  })

  it('11. tree motrix-plugin.json deleted entirely: overlay still effective, manifest from bundle', async () => {
    plantSeed(builtinDir, BUILTIN_ID, '1.0.0')
    plantOverlay(overlayDir, BUILTIN_ID, '1.1.0', trusted)

    rmSync(path.join(overlayDir, BUILTIN_ID, 'motrix-plugin.json'))

    const registry = makeRegistry()
    await registry.discover()

    const indexed = registry.get(BUILTIN_ID)
    expect(indexed?.manifest.version).toBe('1.1.0')
    expect(existsSync(path.join(overlayDir, BUILTIN_ID))).toBe(true)
    const dto = registry.list().find((p) => p.id === BUILTIN_ID)
    expect(dto?.source?.type).toBe('builtin-update')
  })

  it('12. plugin id containing a ".bak-" segment is applied, not mistaken for a backup dir (collision-proofing)', async () => {
    // Regression: REGISTRY_PLUGIN_ID_RE allows hyphenated segments, so
    // 'motrix.bak-tool' is a valid plugin id. Its committed overlay dir is
    // literally named 'motrix.bak-tool', which a substring check
    // (`.includes('.bak-')`) would wrongly skip as an orphaned backup,
    // silently falling back to the (possibly nonexistent) seed. The
    // leading-dot-anchored check (`.startsWith('.bak-')`) must apply it.
    const collisionId = 'motrix.bak-tool'
    plantSeed(builtinDir, collisionId, '1.0.0')
    const { packageUrl } = plantOverlay(
      overlayDir,
      collisionId,
      '1.1.0',
      trusted
    )

    const registry = makeRegistry()
    await registry.discover()

    expect(registry.get(collisionId)?.manifest.version).toBe('1.1.0')
    const dto = registry.list().find((p) => p.id === collisionId)
    expect(dto?.source?.type).toBe('builtin-update')
    expect(dto?.source?.url).toBe(packageUrl)
    expect(existsSync(path.join(overlayDir, collisionId))).toBe(true)
  })
})
