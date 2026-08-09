// Reads / writes / diffs the durable `_install.json` Motrix stores beside
// every installed plugin. Sticking to a single Zod schema lets us evolve
// the record format with `version` discrimination without losing the ability
// to read older payloads.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ConsentSnapshot,
  InstallRecord,
  TrustSurfaceDiff,
} from '@shared/types/plugin-install'
import { INSTALL_SOURCE_TYPES } from '@shared/types/plugin-install'
import { z } from 'zod'

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

export const InstallRecordSchema = z
  .object({
    version: z.literal(1),
    pluginId: z.string().min(1),
    source: z
      .object({
        type: z.enum(INSTALL_SOURCE_TYPES),
        url: z.string().min(1),
        bundleSha256: Sha256Hex,
        recordedAt: z.number().int(),
      })
      .strict(),
    grants: z.record(z.string(), z.enum(['granted', 'denied'])),
    consentSnapshot: z
      .object({
        permissions: z.array(z.string()),
        optionalPermissions: z.array(z.string()),
        invokesCommands: z.array(z.string()),
        publicCommands: z.record(z.string(), Sha256Hex),
        requestedHeapMB: z.number().int().nonnegative(),
        enginesMotrix: z.string().min(1),
        hostPermissions: z.array(z.string()),
      })
      .strict(),
  })
  .strict()

export const INSTALL_RECORD_FILENAME = '_install.json'

export async function readInstallRecord(
  pluginDir: string
): Promise<InstallRecord | null> {
  let raw: string
  try {
    raw = await readFile(path.join(pluginDir, INSTALL_RECORD_FILENAME), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = InstallRecordSchema.safeParse(parsed)
  if (!result.success) return null
  return result.data as InstallRecord
}

export async function writeInstallRecord(
  pluginDir: string,
  rec: InstallRecord
): Promise<void> {
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    path.join(pluginDir, INSTALL_RECORD_FILENAME),
    `${JSON.stringify(rec, null, 2)}\n`
  )
}

function arrayDiff(
  oldA: ReadonlyArray<string>,
  newA: ReadonlyArray<string>
): string[] {
  const oldSet = new Set(oldA)
  return newA.filter((x) => !oldSet.has(x))
}

function semverMajor(version: string): string | null {
  const m = version.match(/(?:\^|~|>=)?\s*(\d+)\./)
  return m ? m[1] : null
}

// Pure trust-surface diff. `sourceUrlChanged` is left null here because the
// source URL lives outside `consentSnapshot`; PluginInstaller.stage fills it
// in after comparing the normalized URLs.
export function diffTrustSurface(
  prev: InstallRecord,
  next: ConsentSnapshot
): TrustSurfaceDiff {
  const prevSnap = prev.consentSnapshot
  const schemaChanged: string[] = []
  for (const [id, hash] of Object.entries(next.publicCommands)) {
    const before = prevSnap.publicCommands[id]
    if (before !== undefined && before !== hash) schemaChanged.push(id)
  }
  const heapInc =
    next.requestedHeapMB > prevSnap.requestedHeapMB
      ? { from: prevSnap.requestedHeapMB, to: next.requestedHeapMB }
      : null
  const prevMajor = semverMajor(prevSnap.enginesMotrix)
  const nextMajor = semverMajor(next.enginesMotrix)
  const majorChange =
    prevMajor && nextMajor && prevMajor !== nextMajor
      ? { from: prevSnap.enginesMotrix, to: next.enginesMotrix }
      : null
  return {
    permissionsAdded: arrayDiff(prevSnap.permissions, next.permissions),
    optionalPermissionsAdded: arrayDiff(
      prevSnap.optionalPermissions,
      next.optionalPermissions
    ),
    invokesCommandsAdded: arrayDiff(
      prevSnap.invokesCommands,
      next.invokesCommands
    ),
    publicCommandsAdded: arrayDiff(
      Object.keys(prevSnap.publicCommands),
      Object.keys(next.publicCommands)
    ),
    publicCommandsSchemaChanged: schemaChanged,
    hostPermissionsAdded: arrayDiff(
      prevSnap.hostPermissions,
      next.hostPermissions
    ),
    requestedHeapMBIncreased: heapInc,
    enginesMotrixMajorChange: majorChange,
    sourceUrlChanged: null,
  }
}

export function requiresConsent(diff: TrustSurfaceDiff): boolean {
  return (
    diff.permissionsAdded.length > 0 ||
    diff.optionalPermissionsAdded.length > 0 ||
    diff.invokesCommandsAdded.length > 0 ||
    diff.publicCommandsAdded.length > 0 ||
    diff.publicCommandsSchemaChanged.length > 0 ||
    diff.hostPermissionsAdded.length > 0 ||
    diff.enginesMotrixMajorChange !== null ||
    diff.sourceUrlChanged !== null
  )
}
