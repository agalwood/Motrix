// Builtin hot-update write path (2026-07-18 design §3). Every gate before
// commit() runs against bytes/dirs OUTSIDE the overlay; only commit()'s
// final rename mutates <overlayDir>/<id>. sha256 alone is never sufficient
// for builtin code — the ed25519 signature check is the trust boundary.

import type { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginManifest } from '@shared/types/plugin'
import { entryOf, keypair, moextOf } from '@test-utils/moext'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuiltinUpdater } from './builtin-updater'

const EFFECTIVE_V1: PluginManifest = {
  manifestVersion: 1,
  id: 'motrix.url-resolver',
  name: 'URL Resolver',
  version: '1.0.0',
  description: 'builtin url resolver',
  categories: ['integration'],
  engines: { motrix: '^2.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: {},
}

let tmp: string
let overlayDir: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-builtin-updater-'))
  overlayDir = path.join(tmp, 'overlay')
  await mkdir(overlayDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function fetchImplOf(bytes: Buffer): typeof fetch {
  return async () =>
    new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })
}

function makeUpdater(
  k: ReturnType<typeof keypair>,
  fetchImpl: typeof fetch
): BuiltinUpdater {
  return new BuiltinUpdater({
    overlayDir,
    hostVersion: '2.5.0',
    pubkeys: [k.pem],
    fetchImpl,
  })
}

describe('BuiltinUpdater', () => {
  it('stage -> commit happy path: overlay populated, _overlay.json matches, same-surface bump is trustChanged:false', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, k, '1.1.0')
    const updater = makeUpdater(k, fetchImplOf(bytes))

    const result = await updater.stage(entry, EFFECTIVE_V1)
    expect(result.trustChanged).toBe(false)
    expect(result.newVersion).toBe('1.1.0')

    const { pluginId } = await updater.commit(result.stagingId)
    expect(pluginId).toBe('motrix.url-resolver')

    const finalDir = path.join(overlayDir, 'motrix.url-resolver')
    const manifestRaw = await readFile(
      path.join(finalDir, 'motrix-plugin.json'),
      'utf8'
    )
    expect(JSON.parse(manifestRaw).version).toBe('1.1.0')

    const bundleOnDisk = await readFile(path.join(finalDir, 'bundle.moext'))
    expect(bundleOnDisk.equals(bytes)).toBe(true)

    const overlayMeta = JSON.parse(
      await readFile(path.join(finalDir, '_overlay.json'), 'utf8')
    )
    expect(overlayMeta.sha256).toBe(entry.package?.sha256)
    expect(overlayMeta.signature).toBe(entry.package?.signature)
    expect(overlayMeta.packageUrl).toBe(entry.package?.url)
  })

  it('missing signature rejects builtin_no_signature; overlay untouched', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, k, '1.1.0', {
      package: { signature: undefined },
    })
    const updater = makeUpdater(k, fetchImplOf(bytes))

    await expect(updater.stage(entry, EFFECTIVE_V1)).rejects.toThrow(
      /builtin_no_signature/
    )
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(false)
  })

  it('signature by a NON-pinned key rejects builtin_bad_signature (sha256 match is not enough)', async () => {
    const k = keypair()
    const other = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, other, '1.1.0')
    const updater = makeUpdater(k, fetchImplOf(bytes))

    await expect(updater.stage(entry, EFFECTIVE_V1)).rejects.toThrow(
      /builtin_bad_signature/
    )
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(false)
  })

  it('manifest id != entry id rejects builtin_wrong_id', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0', { id: 'motrix.other' })
    const entry = entryOf(bytes, k, '1.1.0')
    const updater = makeUpdater(k, fetchImplOf(bytes))

    await expect(updater.stage(entry, EFFECTIVE_V1)).rejects.toThrow(
      /builtin_wrong_id/
    )
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(false)
  })

  it('version not strictly greater than effective rejects builtin_not_newer (equal and lower)', async () => {
    const k = keypair()

    const equalBytes = moextOf('1.0.0')
    const equalEntry = entryOf(equalBytes, k, '1.0.0')
    const equalUpdater = makeUpdater(k, fetchImplOf(equalBytes))
    await expect(equalUpdater.stage(equalEntry, EFFECTIVE_V1)).rejects.toThrow(
      /builtin_not_newer/
    )

    const lowerBytes = moextOf('0.9.0')
    const lowerEntry = entryOf(lowerBytes, k, '0.9.0')
    const lowerUpdater = makeUpdater(k, fetchImplOf(lowerBytes))
    await expect(lowerUpdater.stage(lowerEntry, EFFECTIVE_V1)).rejects.toThrow(
      /builtin_not_newer/
    )
  })

  it('trust surface growth (new permission) reports trustChanged:true with added perm:ffmpeg; nothing lands until commit', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0', { permissions: ['ffmpeg'] })
    const entry = entryOf(bytes, k, '1.1.0', { permissions: ['ffmpeg'] })
    const updater = makeUpdater(k, fetchImplOf(bytes))

    const result = await updater.stage(entry, EFFECTIVE_V1)
    expect(result.trustChanged).toBe(true)
    expect(result.added).toContain('perm:ffmpeg')
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(false)

    await updater.commit(result.stagingId)
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(true)
  })

  it('cancel removes the staging dir; commit after cancel rejects builtin_staging_not_found', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, k, '1.1.0')
    const updater = makeUpdater(k, fetchImplOf(bytes))

    const result = await updater.stage(entry, EFFECTIVE_V1)
    const stagingPath = path.join(overlayDir, result.stagingId)
    expect(existsSync(stagingPath)).toBe(true)

    await updater.cancel(result.stagingId)
    expect(existsSync(stagingPath)).toBe(false)

    await expect(updater.commit(result.stagingId)).rejects.toThrow(
      /builtin_staging_not_found/
    )
  })

  it('commit over an existing overlay entry atomically replaces it', async () => {
    const k = keypair()
    const v1Bytes = moextOf('1.1.0')
    const v1Entry = entryOf(v1Bytes, k, '1.1.0')
    const updater1 = makeUpdater(k, fetchImplOf(v1Bytes))
    const staged1 = await updater1.stage(v1Entry, EFFECTIVE_V1)
    await updater1.commit(staged1.stagingId)

    const finalDir = path.join(overlayDir, 'motrix.url-resolver')
    const v1Bundle = await readFile(path.join(finalDir, 'bundle.moext'))
    expect(v1Bundle.equals(v1Bytes)).toBe(true)

    const EFFECTIVE_V1_1: PluginManifest = {
      ...EFFECTIVE_V1,
      version: '1.1.0',
    }
    const v2Bytes = moextOf('1.2.0')
    const v2Entry = entryOf(v2Bytes, k, '1.2.0')
    const updater2 = makeUpdater(k, fetchImplOf(v2Bytes))
    const staged2 = await updater2.stage(v2Entry, EFFECTIVE_V1_1)
    await updater2.commit(staged2.stagingId)

    const v2Bundle = await readFile(path.join(finalDir, 'bundle.moext'))
    expect(v2Bundle.equals(v2Bytes)).toBe(true)
    expect(v2Bundle.equals(v1Bytes)).toBe(false)

    // no leftover .bak-* directories
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(overlayDir)
    expect(names.some((n) => n.includes('.bak-'))).toBe(false)
  })

  it('cleanupOrphans removes .tmp-* dirs and leaves real entries alone', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, k, '1.1.0')
    const updater = makeUpdater(k, fetchImplOf(bytes))
    const staged = await updater.stage(entry, EFFECTIVE_V1)
    await updater.commit(staged.stagingId)

    const orphan = path.join(overlayDir, '.tmp-orphan-999')
    await mkdir(orphan, { recursive: true })

    await updater.cleanupOrphans()

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(true)
  })

  it('cleans the staging dir when bootstrap write fails', async () => {
    const k = keypair()
    const bytes = moextOf('1.1.0')
    const entry = entryOf(bytes, k, '1.1.0')

    // Use fixed clock so staging path is deterministic
    const FIXED_TIMESTAMP = 1234
    const updater = new BuiltinUpdater({
      overlayDir,
      hostVersion: '2.5.0',
      pubkeys: [k.pem],
      fetchImpl: fetchImplOf(bytes),
      now: () => FIXED_TIMESTAMP,
    })

    // Pre-create the bundle path AS A DIRECTORY, so mkdir will succeed
    // but writeFile will fail with EISDIR
    const stagingDirName = `.tmp-motrix.url-resolver-${FIXED_TIMESTAMP}`
    const stagingDirPath = path.join(overlayDir, stagingDirName)
    const bundlePath = path.join(stagingDirPath, 'bundle.moext')
    await mkdir(bundlePath, { recursive: true })

    // stage() should reject because writeFile onto a directory fails
    await expect(updater.stage(entry, EFFECTIVE_V1)).rejects.toThrow()

    // Verify the staging dir was cleaned up (entire .tmp-* dir removed)
    expect(existsSync(stagingDirPath)).toBe(false)
    // Verify the overlay entry dir was not created (stage failed before commit)
    expect(existsSync(path.join(overlayDir, 'motrix.url-resolver'))).toBe(false)
  })

  it('cleanupOrphans does not delete a committed overlay whose plugin id itself contains ".bak-" (collision-proofing)', async () => {
    // Regression for the id/backup naming collision: REGISTRY_PLUGIN_ID_RE
    // allows hyphenated segments, so a plugin id like 'motrix.bak-tool' is
    // valid and its committed overlay dir is literally named 'motrix.bak-tool'.
    // A substring check (`.includes('.bak-')`) would wrongly classify that
    // legitimate overlay as an orphaned backup and delete it. The
    // leading-dot-anchored check (`.startsWith('.bak-')`) must leave it alone.
    const updater = new BuiltinUpdater({ overlayDir, hostVersion: '2.5.0' })

    const collisionDir = path.join(overlayDir, 'motrix.bak-tool')
    await mkdir(collisionDir, { recursive: true })

    // A real orphaned backup dir under the new leading-dot naming scheme.
    const realBackup = path.join(overlayDir, '.bak-motrix.url-resolver-123')
    await mkdir(realBackup, { recursive: true })

    // A real orphaned staging dir.
    const realStaging = path.join(overlayDir, '.tmp-motrix.url-resolver-456')
    await mkdir(realStaging, { recursive: true })

    await updater.cleanupOrphans()

    expect(existsSync(collisionDir)).toBe(true)
    expect(existsSync(realBackup)).toBe(false)
    expect(existsSync(realStaging)).toBe(false)
  })
})
