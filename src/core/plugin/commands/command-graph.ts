import { once } from 'node:events'
import type { ReadStream, Stats } from 'node:fs'
import { createReadStream, fstat } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type {
  PluginCommandGraphDTO,
  PluginCommandGraphEdge,
} from '@shared/types/plugin-command-graph'
import { z } from 'zod'

const ACTIVE_FILENAME = 'command-invokes.ndjson'
const RETENTION_FILENAME = 'command-invokes.retention.json'
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_RETENTION_MARKER_BYTES = 4 * 1024

const identifierSchema = z.string().trim().min(1).max(512)
const auditRecordSchema = z
  .object({
    ts: z.number().finite(),
    type: z.literal('command.invoke'),
    caller: identifierSchema,
    callee: identifierSchema,
    commandId: identifierSchema,
    ok: z.literal(true),
  })
  .refine((entry) => entry.caller !== entry.callee)
const retentionMarkerSchema = z
  .object({
    version: z.literal(1),
    droppedThrough: z.number().finite(),
  })
  .strict()

export interface ReadCommandGraphOptions {
  windowMs?: number
  now?: number
  maxScanBytes?: number
}

interface StreamOptions {
  encoding: 'utf8'
  start: number
  end: number
}

interface ReadCommandGraphDependencies {
  readdir(directory: string): Promise<string[]>
  stat(file: string): Promise<Stats>
  fstat(fileDescriptor: number): Promise<Stats>
  createReadStream(file: string, options: StreamOptions): ReadStream
}

interface Candidate {
  file: string
  rotationTimestamp: number | null
}

interface Snapshot extends Candidate {
  bytes: number
  dev: number
  ino: number
}

interface Aggregate {
  calls: number
  lastCalledAt: number
}

interface ReadAttempt {
  edges: PluginCommandGraphEdge[]
  truncated: boolean
  retry: boolean
}

const nodeDependencies: ReadCommandGraphDependencies = {
  readdir: (directory) => readdir(directory),
  stat: (file) => stat(file),
  fstat: promisify(fstat),
  createReadStream: (file, options) => createReadStream(file, options),
}

export async function readCommandGraph(
  file: string,
  options: ReadCommandGraphOptions = {},
  dependencyOverrides: Partial<ReadCommandGraphDependencies> = {}
): Promise<PluginCommandGraphDTO> {
  const dependencies = { ...nodeDependencies, ...dependencyOverrides }
  const generatedAt = options.now ?? Date.now()
  const cutoff = generatedAt - (options.windowMs ?? DEFAULT_WINDOW_MS)
  const maxScanBytes = Math.max(
    0,
    options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
  )
  let attempt = await readSnapshot(
    file,
    cutoff,
    generatedAt,
    maxScanBytes,
    false,
    dependencies
  )
  if (attempt.retry) {
    attempt = await readSnapshot(
      file,
      cutoff,
      generatedAt,
      maxScanBytes,
      true,
      dependencies
    )
  }
  const markerTruncated = await readRetentionMarker(
    path.join(path.dirname(file), RETENTION_FILENAME),
    cutoff,
    dependencies
  )

  return {
    edges: attempt.edges,
    generatedAt,
    cutoff,
    truncated: markerTruncated || attempt.truncated,
  }
}

async function readSnapshot(
  file: string,
  cutoff: number,
  generatedAt: number,
  maxScanBytes: number,
  afterRediscovery: boolean,
  dependencies: ReadCommandGraphDependencies
): Promise<ReadAttempt> {
  const discovery = await discoverCandidates(file, cutoff, dependencies)
  if (discovery.missingDirectory) {
    return {
      edges: [],
      truncated: afterRediscovery,
      retry: false,
    }
  }

  const snapshot = await snapshotCandidates(
    discovery.candidates,
    maxScanBytes,
    afterRediscovery,
    dependencies
  )
  if (snapshot.retry) {
    return { edges: [], truncated: false, retry: true }
  }

  const aggregates = new Map<string, Map<string, Map<string, Aggregate>>>()
  const boundedRecordSchema = auditRecordSchema.refine(
    (entry) => entry.ts >= cutoff && entry.ts <= generatedAt
  )
  const openedIdentities = new Set<string>()
  let truncated = snapshot.truncated

  for (const entry of snapshot.files) {
    let stream: ReadStream | null = null
    try {
      stream = dependencies.createReadStream(entry.file, {
        encoding: 'utf8',
        start: 0,
        end: entry.bytes - 1,
      })
      const [fileDescriptor] = await once(stream, 'open')
      if (typeof fileDescriptor !== 'number') {
        throw new Error(`Audit stream did not expose a file descriptor`)
      }
      const openedStat = await dependencies.fstat(fileDescriptor)
      if (openedStat.dev !== entry.dev || openedStat.ino !== entry.ino) {
        if (!afterRediscovery) {
          return { edges: [], truncated: false, retry: true }
        }
        truncated = true
        continue
      }
      const identity = fileIdentity(openedStat.dev, openedStat.ino)
      if (openedIdentities.has(identity)) continue
      openedIdentities.add(identity)
      const lines = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      })
      stream = null
      for await (const line of lines) {
        if (line.length === 0) continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = boundedRecordSchema.safeParse(raw)
        if (!parsed.success) continue
        addRecord(aggregates, parsed.data)
      }
    } catch (error) {
      if (!isEnoent(error)) throw error
      if (!afterRediscovery) {
        return { edges: [], truncated: false, retry: true }
      }
      truncated = true
    } finally {
      stream?.destroy()
    }
  }

  return {
    edges: flattenAggregates(aggregates),
    truncated,
    retry: false,
  }
}

async function discoverCandidates(
  file: string,
  cutoff: number,
  dependencies: ReadCommandGraphDependencies
): Promise<{ candidates: Candidate[]; missingDirectory: boolean }> {
  let names: string[]
  try {
    names = await dependencies.readdir(path.dirname(file))
  } catch (error) {
    if (isEnoent(error)) return { candidates: [], missingDirectory: true }
    throw error
  }

  const candidates: Candidate[] = []
  if (names.includes(ACTIVE_FILENAME)) {
    candidates.push({ file, rotationTimestamp: null })
  }
  for (const name of names) {
    const rotationTimestamp = rotationTimestampFromName(name)
    if (rotationTimestamp === null || rotationTimestamp < cutoff) continue
    candidates.push({
      file: path.join(path.dirname(file), name),
      rotationTimestamp,
    })
  }
  candidates.sort(compareCandidates)
  return { candidates, missingDirectory: false }
}

function rotationTimestampFromName(name: string): number | null {
  const match = /^command-invokes\.ndjson\.(\d+)$/.exec(name)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.rotationTimestamp === null) return -1
  if (b.rotationTimestamp === null) return 1
  const byTimestamp = b.rotationTimestamp - a.rotationTimestamp
  return byTimestamp === 0 ? compareText(a.file, b.file) : byTimestamp
}

async function snapshotCandidates(
  candidates: Candidate[],
  maxScanBytes: number,
  afterRediscovery: boolean,
  dependencies: ReadCommandGraphDependencies
): Promise<{
  files: Snapshot[]
  truncated: boolean
  retry: boolean
}> {
  const sizes: Array<Candidate & { size: number; dev: number; ino: number }> =
    []
  const snapshottedIdentities = new Set<string>()
  let truncated = false

  for (const candidate of candidates) {
    try {
      const fileStat = await dependencies.stat(candidate.file)
      if (!fileStat.isFile()) continue
      const identity = fileIdentity(fileStat.dev, fileStat.ino)
      if (snapshottedIdentities.has(identity)) continue
      snapshottedIdentities.add(identity)
      sizes.push({
        ...candidate,
        size: fileStat.size,
        dev: fileStat.dev,
        ino: fileStat.ino,
      })
    } catch (error) {
      if (!isEnoent(error)) throw error
      if (!afterRediscovery) {
        return { files: [], truncated: false, retry: true }
      }
      truncated = true
    }
  }

  let remaining = maxScanBytes
  const files: Snapshot[] = []
  for (const candidate of sizes) {
    const bytes = Math.min(candidate.size, remaining)
    if (bytes > 0) files.push({ ...candidate, bytes })
    if (bytes < candidate.size) truncated = true
    remaining -= bytes
  }
  return { files, truncated, retry: false }
}

function fileIdentity(device: number, inode: number): string {
  return `${device}:${inode}`
}

async function readRetentionMarker(
  marker: string,
  cutoff: number,
  dependencies: ReadCommandGraphDependencies
): Promise<boolean> {
  let markerStat: Stats
  try {
    markerStat = await dependencies.stat(marker)
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
  if (!markerStat.isFile() || markerStat.size === 0) return true
  if (markerStat.size > MAX_RETENTION_MARKER_BYTES) return true

  let raw = ''
  try {
    const stream = dependencies.createReadStream(marker, {
      encoding: 'utf8',
      start: 0,
      end: markerStat.size - 1,
    })
    for await (const chunk of stream) raw += chunk
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }

  try {
    const parsed = retentionMarkerSchema.safeParse(JSON.parse(raw))
    return !parsed.success || parsed.data.droppedThrough >= cutoff
  } catch {
    return true
  }
}

function addRecord(
  aggregates: Map<string, Map<string, Map<string, Aggregate>>>,
  entry: z.infer<typeof auditRecordSchema>
): void {
  let targets = aggregates.get(entry.caller)
  if (!targets) {
    targets = new Map()
    aggregates.set(entry.caller, targets)
  }
  let commands = targets.get(entry.callee)
  if (!commands) {
    commands = new Map()
    targets.set(entry.callee, commands)
  }
  const aggregate = commands.get(entry.commandId)
  if (aggregate) {
    aggregate.calls += 1
    aggregate.lastCalledAt = Math.max(aggregate.lastCalledAt, entry.ts)
  } else {
    commands.set(entry.commandId, { calls: 1, lastCalledAt: entry.ts })
  }
}

function flattenAggregates(
  aggregates: Map<string, Map<string, Map<string, Aggregate>>>
): PluginCommandGraphEdge[] {
  const edges: PluginCommandGraphEdge[] = []
  for (const [sourcePluginId, targets] of aggregates) {
    for (const [targetPluginId, commands] of targets) {
      for (const [commandId, aggregate] of commands) {
        edges.push({
          sourcePluginId,
          targetPluginId,
          commandId,
          calls: aggregate.calls,
          lastCalledAt: aggregate.lastCalledAt,
        })
      }
    }
  }
  return edges.sort(
    (a, b) =>
      compareText(a.sourcePluginId, b.sourcePluginId) ||
      compareText(a.targetPluginId, b.targetPluginId) ||
      compareText(a.commandId, b.commandId)
  )
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
