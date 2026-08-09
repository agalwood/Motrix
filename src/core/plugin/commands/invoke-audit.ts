// src/core/plugin/commands/invoke-audit.ts
//
// Buffered NDJSON appender for cross-plugin command invocations.
//
// Why this exists (Plan D Task 6):
// - CrossPluginInvoker calls audit.log(entry) after every invocation
//   attempt (success OR failure). That happens on the hot path so the
//   call must be synchronous and never throw — we can't let an audit
//   write stall or kill a plugin command.
// - Entries are coalesced into a single appendFile per flush via the
//   "double-buffer" pattern: while one flush is in flight, additional
//   log() calls accumulate into the buffer; the next flush picks them
//   up. This keeps disk syscalls bounded under bursty load without
//   losing entries on the boundary.
// - The audit file feeds the Plugins page Integrations tab via the
//   GetPluginCommandGraph query (Task 11). Rotation prevents the file
//   from growing without bound across a long-lived process.
//
// All FS errors (mkdir, appendFile, stat, rename) are swallowed — audit
// failures must never propagate to the invoker.

import { randomUUID } from 'node:crypto'
import {
  appendFile,
  link,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

export interface CommandInvokeEntry {
  caller: string
  callee: string
  commandId: string
  argsSize: number
  resultSize?: number
  durMs: number
  depth: number
  ok: boolean
  errorCode?: string
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000
const DEFAULT_MAX_RETENTION_BYTES = 256 * 1024 * 1024
const GRAPH_WINDOW_MS = 24 * 60 * 60 * 1000
const RETENTION_FILENAME = 'command-invokes.retention.json'

interface Rotation {
  file: string
  timestamp: number
  size: number
}

export interface CommandInvokeRetentionOptions {
  now?: () => number
  retentionMs?: number
  maxRetentionBytes?: number
  atomicWriteMarker?: (file: string, contents: string) => Promise<void>
  renameMarker?: (source: string, target: string) => Promise<void>
}

export class CommandInvokeAudit {
  private readonly file: string
  private readonly maxFileBytes: number
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly maxRetentionBytes: number
  private readonly atomicWriteMarker: (
    file: string,
    contents: string
  ) => Promise<void>
  private buffer: string[] = []
  private flushing = false
  // Promise of the in-flight flush, so drain() can await it deterministically
  // instead of polling.
  private inflight: Promise<void> | null = null
  private lastRotationTimestamp = Number.NEGATIVE_INFINITY

  constructor(
    file: string,
    maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
    retentionOptions: CommandInvokeRetentionOptions = {}
  ) {
    this.file = file
    this.maxFileBytes = maxFileBytes
    this.now = retentionOptions.now ?? (() => Date.now())
    this.retentionMs = retentionOptions.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxRetentionBytes =
      retentionOptions.maxRetentionBytes ?? DEFAULT_MAX_RETENTION_BYTES
    this.atomicWriteMarker =
      retentionOptions.atomicWriteMarker ??
      ((file, contents) =>
        atomicWriteMarker(file, contents, retentionOptions.renameMarker))
  }

  log(entry: CommandInvokeEntry): void {
    const record = {
      ts: this.now(),
      type: 'command.invoke' as const,
      ...entry,
    }
    this.buffer.push(JSON.stringify(record))
    if (!this.flushing) {
      this.flushing = true
      this.inflight = this.flush()
    }
  }

  async drain(): Promise<void> {
    // Loop until both the buffer is empty AND no flush is mid-air. A new
    // log() during the awaited flush would re-arm flushing=true and refill
    // the buffer, so we re-check both conditions every iteration.
    while (this.flushing || this.buffer.length > 0) {
      if (this.inflight) {
        await this.inflight
      } else if (this.buffer.length > 0) {
        this.flushing = true
        this.inflight = this.flush()
      }
    }
  }

  private async flush(): Promise<void> {
    try {
      // Swap the buffer atomically so concurrent log() calls during the
      // ensuing awaits append to a fresh array, not the slice we are
      // about to write.
      const pending = this.buffer
      this.buffer = []
      const data = `${pending.join('\n')}\n`

      try {
        await mkdir(path.dirname(this.file), { recursive: true })
        await appendFile(this.file, data, 'utf8')
        const st = await stat(this.file)
        if (st.size > this.maxFileBytes) {
          await this.rotateActiveFile()
          await this.cleanupRotations()
        }
      } catch {
        // Swallow: audit is best-effort and must not break the hot path.
      }
    } finally {
      // Clear flushing AFTER the FS round-trip so concurrent log() calls
      // do not schedule overlapping appendFile()s on the same file. Any
      // entries that arrived during the in-flight flush are still sitting
      // in this.buffer; chain a follow-up flush to drain them.
      this.flushing = false
      this.inflight = null
      if (this.buffer.length > 0) {
        this.flushing = true
        this.inflight = this.flush()
      }
    }
  }

  private async rotateActiveFile(): Promise<void> {
    let timestamp = Math.max(
      this.now(),
      Number.isFinite(this.lastRotationTimestamp)
        ? this.lastRotationTimestamp + 1
        : Number.NEGATIVE_INFINITY
    )

    while (true) {
      const target = `${this.file}.${timestamp}`
      try {
        await link(this.file, target)
      } catch (error) {
        if (!isEexist(error)) throw error
        timestamp += 1
        continue
      }

      try {
        await unlink(this.file)
        this.lastRotationTimestamp = timestamp
        return
      } catch (error) {
        await tryDelete(target)
        throw error
      }
    }
  }

  private async cleanupRotations(): Promise<void> {
    const directory = path.dirname(this.file)
    const now = this.now()
    const rotations = await discoverRotations(directory)
    const retained: Rotation[] = []

    for (const rotation of rotations) {
      if (rotation.timestamp < now - this.retentionMs) {
        if (!(await tryDelete(rotation.file))) retained.push(rotation)
      } else {
        retained.push(rotation)
      }
    }

    let retainedBytes = retained.reduce(
      (total, rotation) => total + rotation.size,
      0
    )
    const capDeletions: Rotation[] = []
    for (const rotation of retained) {
      if (retainedBytes <= this.maxRetentionBytes) break
      capDeletions.push(rotation)
      retainedBytes -= rotation.size
    }
    if (capDeletions.length === 0) return

    const firstEligible = capDeletions.findIndex(
      (rotation) => rotation.timestamp >= now - GRAPH_WINDOW_MS
    )
    const unmarked =
      firstEligible === -1 ? capDeletions : capDeletions.slice(0, firstEligible)
    for (const rotation of unmarked) await tryDelete(rotation.file)
    if (firstEligible === -1) return

    const eligible = capDeletions.slice(firstEligible)
    const droppedThrough = eligible.at(-1)?.timestamp
    if (droppedThrough === undefined) return
    try {
      await this.atomicWriteMarker(
        path.join(directory, RETENTION_FILENAME),
        JSON.stringify({ version: 1, droppedThrough })
      )
    } catch {
      return
    }
    for (const rotation of eligible) await tryDelete(rotation.file)
  }
}

async function discoverRotations(directory: string): Promise<Rotation[]> {
  const rotations: Rotation[] = []
  for (const name of await readdir(directory)) {
    const match = /^command-invokes\.ndjson\.(\d+)$/.exec(name)
    if (!match) continue
    const timestamp = Number(match[1])
    if (!Number.isFinite(timestamp)) continue
    const file = path.join(directory, name)
    try {
      const fileStat = await stat(file)
      if (fileStat.isFile()) {
        rotations.push({ file, timestamp, size: fileStat.size })
      }
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
  }
  return rotations.sort(
    (a, b) => a.timestamp - b.timestamp || a.file.localeCompare(b.file)
  )
}

async function tryDelete(file: string): Promise<boolean> {
  try {
    await unlink(file)
    return true
  } catch {
    return false
  }
}

async function atomicWriteMarker(
  file: string,
  contents: string,
  renameMarker: (source: string, target: string) => Promise<void> = rename
): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' })
    await renameMarker(temporary, file)
  } finally {
    await tryDelete(temporary)
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  )
}
