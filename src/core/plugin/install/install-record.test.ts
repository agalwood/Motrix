import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ConsentSnapshot,
  InstallRecord,
} from '@shared/types/plugin-install'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  diffTrustSurface,
  INSTALL_RECORD_FILENAME,
  readInstallRecord,
  requiresConsent,
  writeInstallRecord,
} from './install-record'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-install-record-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeRecord(over: Partial<InstallRecord> = {}): InstallRecord {
  return {
    version: 1,
    pluginId: 'com.example.plugin',
    source: {
      type: 'github',
      url: 'https://github.com/example/plugin',
      bundleSha256: 'a'.repeat(64),
      recordedAt: 1_000_000,
    },
    grants: {},
    consentSnapshot: {
      permissions: ['http'],
      optionalPermissions: [],
      invokesCommands: [],
      publicCommands: {},
      requestedHeapMB: 32,
      enginesMotrix: '^2.0.0',
      hostPermissions: [],
    },
    ...over,
  }
}

describe('install-record', () => {
  it('readInstallRecord returns null when file is missing', async () => {
    expect(await readInstallRecord(tmp)).toBeNull()
  })

  it('writeInstallRecord + readInstallRecord round-trips', async () => {
    const rec = makeRecord()
    await writeInstallRecord(tmp, rec)
    const read = await readInstallRecord(tmp)
    expect(read).toEqual(rec)
  })

  it('writeInstallRecord adds a trailing newline (POSIX-friendly)', async () => {
    await writeInstallRecord(tmp, makeRecord())
    const raw = await readFile(path.join(tmp, INSTALL_RECORD_FILENAME), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('readInstallRecord returns null when JSON is malformed', async () => {
    await writeFile(path.join(tmp, INSTALL_RECORD_FILENAME), '{')
    expect(await readInstallRecord(tmp)).toBeNull()
  })

  it('readInstallRecord returns null when shape is wrong', async () => {
    await writeFile(
      path.join(tmp, INSTALL_RECORD_FILENAME),
      JSON.stringify({ version: 1, pluginId: 'x' })
    )
    expect(await readInstallRecord(tmp)).toBeNull()
  })

  it('readInstallRecord rejects records with bad bundleSha256 hex length', async () => {
    const bad = makeRecord({
      source: {
        type: 'github',
        url: 'https://github.com/example/plugin',
        bundleSha256: 'shorthash',
        recordedAt: 0,
      },
    })
    await writeFile(
      path.join(tmp, INSTALL_RECORD_FILENAME),
      JSON.stringify(bad)
    )
    expect(await readInstallRecord(tmp)).toBeNull()
  })

  it('writeInstallRecord + readInstallRecord round-trips a registry source', async () => {
    const rec = makeRecord({
      source: {
        type: 'registry',
        url: 'registry:acme.speed-boost',
        bundleSha256: 'b'.repeat(64),
        recordedAt: 1_000_000,
      },
    })
    await writeInstallRecord(tmp, rec)
    const read = await readInstallRecord(tmp)
    expect(read).not.toBeNull()
    expect(read?.source.type).toBe('registry')
    expect(read).toEqual(rec)
  })

  it('diffTrustSurface flags new permissions / invokes / hostPermissions', () => {
    const prev = makeRecord()
    const next: ConsentSnapshot = {
      ...prev.consentSnapshot,
      permissions: ['http', 'storage'],
      invokesCommands: ['other.plugin.cmd'],
      hostPermissions: ['https://api.example.com/*'],
    }
    const diff = diffTrustSurface(prev, next)
    expect(diff.permissionsAdded).toEqual(['storage'])
    expect(diff.invokesCommandsAdded).toEqual(['other.plugin.cmd'])
    expect(diff.hostPermissionsAdded).toEqual(['https://api.example.com/*'])
    expect(diff.requestedHeapMBIncreased).toBeNull()
    expect(diff.enginesMotrixMajorChange).toBeNull()
    expect(requiresConsent(diff)).toBe(true)
  })

  it('diffTrustSurface returns empty diff when nothing changed', () => {
    const prev = makeRecord()
    const diff = diffTrustSurface(prev, prev.consentSnapshot)
    expect(diff.permissionsAdded).toEqual([])
    expect(diff.optionalPermissionsAdded).toEqual([])
    expect(diff.publicCommandsAdded).toEqual([])
    expect(diff.publicCommandsSchemaChanged).toEqual([])
    expect(requiresConsent(diff)).toBe(false)
  })

  it('diffTrustSurface flags publicCommandsSchemaChanged for hash flips', () => {
    const prev = makeRecord({
      consentSnapshot: {
        permissions: [],
        optionalPermissions: [],
        invokesCommands: [],
        publicCommands: { 'p.cmd': 'a'.repeat(64) },
        requestedHeapMB: 32,
        enginesMotrix: '^2.0.0',
        hostPermissions: [],
      },
    })
    const next: ConsentSnapshot = {
      ...prev.consentSnapshot,
      publicCommands: { 'p.cmd': 'b'.repeat(64) },
    }
    const diff = diffTrustSurface(prev, next)
    expect(diff.publicCommandsSchemaChanged).toEqual(['p.cmd'])
    expect(diff.publicCommandsAdded).toEqual([])
    expect(requiresConsent(diff)).toBe(true)
  })

  it('diffTrustSurface flags new public command without hash flip', () => {
    const prev = makeRecord()
    const next: ConsentSnapshot = {
      ...prev.consentSnapshot,
      publicCommands: { 'p.newCmd': 'c'.repeat(64) },
    }
    const diff = diffTrustSurface(prev, next)
    expect(diff.publicCommandsAdded).toEqual(['p.newCmd'])
    expect(diff.publicCommandsSchemaChanged).toEqual([])
    expect(requiresConsent(diff)).toBe(true)
  })

  it('diffTrustSurface flags requestedHeapMB increase but not decrease', () => {
    const prev = makeRecord({
      consentSnapshot: {
        ...makeRecord().consentSnapshot,
        requestedHeapMB: 32,
      },
    })
    const grew = diffTrustSurface(prev, {
      ...prev.consentSnapshot,
      requestedHeapMB: 64,
    })
    expect(grew.requestedHeapMBIncreased).toEqual({ from: 32, to: 64 })

    const shrank = diffTrustSurface(prev, {
      ...prev.consentSnapshot,
      requestedHeapMB: 16,
    })
    expect(shrank.requestedHeapMBIncreased).toBeNull()
  })

  it('diffTrustSurface flags major engines bump only', () => {
    const prev = makeRecord({
      consentSnapshot: {
        ...makeRecord().consentSnapshot,
        enginesMotrix: '^2.0.0',
      },
    })

    const minor = diffTrustSurface(prev, {
      ...prev.consentSnapshot,
      enginesMotrix: '^2.5.0',
    })
    expect(minor.enginesMotrixMajorChange).toBeNull()

    const major = diffTrustSurface(prev, {
      ...prev.consentSnapshot,
      enginesMotrix: '^3.0.0',
    })
    expect(major.enginesMotrixMajorChange).toEqual({
      from: '^2.0.0',
      to: '^3.0.0',
    })
    expect(requiresConsent(major)).toBe(true)
  })

  it('requiresConsent treats sourceUrlChanged alone as consent-required', () => {
    const diff = {
      permissionsAdded: [],
      optionalPermissionsAdded: [],
      invokesCommandsAdded: [],
      publicCommandsAdded: [],
      publicCommandsSchemaChanged: [],
      hostPermissionsAdded: [],
      requestedHeapMBIncreased: null,
      enginesMotrixMajorChange: null,
      sourceUrlChanged: {
        from: 'https://github.com/a/b',
        to: 'https://github.com/c/d',
      },
    }
    expect(requiresConsent(diff)).toBe(true)
  })
})
