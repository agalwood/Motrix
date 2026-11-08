import { randomUUID } from 'node:crypto'
import { close, open } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  redactLogFields,
  redactLogText,
  truncateLogText,
} from '@core/log-redact'
import { pluginLogSequence } from '@shared/lib/plugin-log-order'
import {
  PLUGIN_LOG_VERBOSE_TTL_MS,
  type PluginLogState,
} from '@shared/schemas/plugin-logs'
import pino, { type DestinationStream, type Logger } from 'pino'
import type { LogEntry, PluginLogCapability } from './interface'
import { readPluginLogTail } from './log-history'

export const PLUGIN_LOG_MAX_BUFFER_BYTES = 1024 * 1024
export const PLUGIN_LOG_MAX_ENTRY_BYTES = 64 * 1024
export const PLUGIN_LOG_MAX_RING_BYTES = 512 * 1024
const MAX_PENDING_ENTRIES = 512

export interface LogCapabilityHostOptions {
  pluginLogsDir: string
  ringSize?: number
}
export type LogStreamListener = (pluginId: string, entry: LogEntry) => void

type LogDestination = ReturnType<typeof pino.destination>
interface Per {
  logger?: Logger
  dest?: LogDestination
  opened?: Promise<boolean>
  ring: LogEntry[]
  ringBytes: number
  verboseUntil: number | null
  clearing?: Promise<void>
  clearThrough?: number
  pending: Array<{ data: string; sequence: number }>
  pendingBytes: number
  sequence: number
  unavailable: boolean
  dropped: number
  reportingDrop: boolean
  markerRejected: boolean
  retiring: boolean
  retired: boolean
  destinationClosed: boolean
  releasing?: Promise<void>
}

function entryBytes(entry: LogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

function boundEntry(entry: LogEntry): LogEntry {
  // Leave room for the serializer's host metadata. Oversized structured fields
  // are diagnostic only; never retain their original object in a write closure.
  if (entryBytes(entry) <= PLUGIN_LOG_MAX_ENTRY_BYTES - 1024) return entry
  return {
    entryId: entry.entryId,
    logSequence: entry.logSequence,
    ts: entry.ts,
    level: entry.level,
    msg: entry.msg.slice(0, 8192),
    fieldsTruncated: true,
  }
}

async function flushDestination(per: Per): Promise<void> {
  if (!per.opened) return
  if (!(await per.opened) || !per.dest)
    throw new Error('Plugin log file is unavailable')
  const destination = per.dest
  await new Promise<void>((resolve, reject) => {
    try {
      // minLength > 0 makes SonicBoom flush wait for drain and fsync.
      destination.flush((error) => (error ? reject(error) : resolve()))
    } catch (error) {
      reject(error)
    }
  })
}

export class LogCapabilityHost {
  private readonly opts: Required<LogCapabilityHostOptions>
  private readonly per = new Map<string, Per>()
  private readonly subscribers = new Set<LogStreamListener>()
  private closing = false
  private closePromise?: Promise<void>

  constructor(opts: LogCapabilityHostOptions) {
    this.opts = { ringSize: 100, ...opts }
  }

  private logPath(pluginId: string): string {
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(pluginId))
      throw new Error('Invalid plugin log identifier')
    return path.join(
      this.opts.pluginLogsDir,
      pluginId,
      'logs',
      'current.ndjson'
    )
  }

  private appendRing(per: Per, entry: LogEntry): void {
    per.ring.push(entry)
    per.ringBytes += entryBytes(entry)
    while (
      per.ring.length > this.opts.ringSize ||
      per.ringBytes > PLUGIN_LOG_MAX_RING_BYTES
    ) {
      const removed = per.ring.shift()
      if (removed) per.ringBytes -= entryBytes(removed)
    }
  }

  private notify(pluginId: string, entry: LogEntry): void {
    for (const listener of this.subscribers) {
      try {
        listener(pluginId, entry)
      } catch {
        /* Diagnostics must not poison their producer. */
      }
    }
  }

  private getOrCreate(pluginId: string): Per {
    const existing = this.per.get(pluginId)
    if (existing) return existing
    const file = this.logPath(pluginId)
    const { entries } = readPluginLogTail(file, this.opts.ringSize)
    const per: Per = {
      ring: [],
      ringBytes: 0,
      verboseUntil: null,
      pending: [],
      pendingBytes: 0,
      sequence: Math.max(
        0,
        ...entries.map((entry) => pluginLogSequence(entry) ?? 0)
      ),
      unavailable: false,
      dropped: 0,
      reportingDrop: false,
      markerRejected: false,
      retiring: false,
      retired: false,
      destinationClosed: false,
    }
    for (const entry of entries) this.appendRing(per, boundEntry(entry))
    this.per.set(pluginId, per)
    // Pino serializes synchronously into our bounded sink. History inspection
    // alone never creates a file descriptor or a periodic flush timer.
    per.logger = pino({ base: undefined, timestamp: false, level: 'trace' }, {
      write: (data: string) => this.write(pluginId, per, data),
    } as DestinationStream)
    return per
  }

  private ensureOpen(pluginId: string, per: Per): Promise<boolean> {
    per.opened ??= (async () => {
      const file = this.logPath(pluginId)
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const fd = await new Promise<number>((resolve, reject) => {
          open(file, 'a', (error, descriptor) =>
            error ? reject(error) : resolve(descriptor)
          )
        })
        try {
          const dest = pino.destination({
            dest: String(fd),
            sync: false,
            minLength: 4096,
            periodicFlush: 1000,
            maxLength: PLUGIN_LOG_MAX_BUFFER_BYTES,
          })
          per.destinationClosed = false
          dest.once('close', () => {
            per.destinationClosed = true
          })
          dest.on('error', () => {})
          dest.on('drop', () => {
            if (per.reportingDrop) per.markerRejected = true
            else per.dropped++
          })
          dest.on('drain', () => this.reportDropped(pluginId, per))
          per.dest = dest
          // Inspect the tail at open time: a read-only inspection may precede
          // opening by minutes, or another process may have finished a line.
          if (readPluginLogTail(file, 0).needsNewline) dest.write('\n')
        } catch (error) {
          close(fd, () => {})
          throw error
        }
        this.drainPending(per)
        return true
      } catch {
        per.unavailable = true
        per.dropped += per.pending.length
        per.pending.length = 0
        per.pendingBytes = 0
        return false
      }
    })()
    return per.opened
  }

  private write(pluginId: string, per: Per, data: string): void {
    if (per.retiring || per.retired || this.closing) return
    if (per.unavailable) {
      per.dropped++
      return
    }
    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > PLUGIN_LOG_MAX_ENTRY_BYTES) {
      per.dropped++
      return
    }
    if (!per.dest || per.clearing) {
      if (
        per.pending.length >= MAX_PENDING_ENTRIES ||
        per.pendingBytes + bytes > PLUGIN_LOG_MAX_BUFFER_BYTES
      ) {
        per.dropped++
        return
      }
      per.pending.push({ data, sequence: per.sequence })
      per.pendingBytes += bytes
      void this.ensureOpen(pluginId, per)
    } else {
      per.dest.write(data)
    }
  }

  private drainPending(per: Per): void {
    if (!per.dest) return
    while (per.pending.length) {
      const next = per.pending[0]
      if (per.clearThrough !== undefined && next.sequence > per.clearThrough)
        return
      per.dest.write(next.data)
      per.pending.shift()
      per.pendingBytes -= Buffer.byteLength(next.data, 'utf8')
    }
  }

  private reportDropped(pluginId: string, per: Per): void {
    if (
      !per.dropped ||
      per.clearing ||
      per.reportingDrop ||
      !per.dest ||
      per.destinationClosed
    )
      return
    const count = per.dropped
    const entry: LogEntry = {
      entryId: randomUUID(),
      logSequence: ++per.sequence,
      ts: Date.now(),
      level: 'warn',
      msg: 'Plugin diagnostic records were dropped because the log buffer was unavailable or full',
      droppedEntries: count,
    }
    per.reportingDrop = true
    per.markerRejected = false
    try {
      const { ts, level: _level, ...fields } = entry
      per.dest.write(`${JSON.stringify({ ...fields, level: 40, time: ts })}\n`)
    } finally {
      per.reportingDrop = false
    }
    if (per.markerRejected) return
    per.dropped -= count
    this.appendRing(per, entry)
    this.notify(pluginId, entry)
  }

  create(pluginId: string): PluginLogCapability {
    const per = this.closing ? undefined : this.getOrCreate(pluginId)
    const push = (
      level: LogEntry['level'],
      msg: string,
      fields?: Record<string, unknown>
    ) => {
      if (!per || this.closing || per.retiring || per.retired) return
      const verbose = this.isVerbose(pluginId)
      const safe = fields
        ? redactLogFields(fields, { profile: 'plugin', verbose })
        : {}
      const entry = boundEntry({
        ...safe,
        entryId: randomUUID(),
        logSequence: ++per.sequence,
        ts: Date.now(),
        level,
        msg: verbose ? truncateLogText(msg) : redactLogText(msg),
      })
      this.appendRing(per, entry)
      const { ts, level: _level, msg: message, ...record } = entry
      per.logger?.[level]({ ...record, time: ts }, message)
      this.notify(pluginId, entry)
    }
    return {
      trace: (m, f) => push('trace', m, f),
      debug: (m, f) => push('debug', m, f),
      info: (m, f) => push('info', m, f),
      warn: (m, f) => push('warn', m, f),
      error: (m, f) => push('error', m, f),
      fatal: (m, f) => push('fatal', m, f),
    }
  }

  getTail(pluginId: string, limit: number): LogEntry[] {
    if (this.closing) return []
    const per = this.getOrCreate(pluginId)
    const count = Number.isFinite(limit)
      ? Math.max(0, Math.min(this.opts.ringSize, Math.floor(limit)))
      : this.opts.ringSize
    return count === 0 ? [] : per.ring.slice(-count)
  }

  clear(pluginId: string): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error('Plugin logs are closing'))
    const per = this.getOrCreate(pluginId)
    if (per.retiring) return Promise.reject(new Error('Plugin log is closing'))
    if (per.clearing) return per.clearing
    if (per.unavailable) {
      per.unavailable = false
      per.opened = undefined
    }
    void this.ensureOpen(pluginId, per)
    const previous = new Set(per.ring)
    const droppedBefore = per.dropped
    per.clearThrough = per.sequence
    const clearing = (async () => {
      await flushDestination(per)
      await fs.truncate(this.logPath(pluginId), 0)
      per.ring = per.ring.filter((entry) => !previous.has(entry))
      per.ringBytes = per.ring.reduce(
        (sum, entry) => sum + entryBytes(entry),
        0
      )
      per.dropped = Math.max(0, per.dropped - droppedBefore)
    })().finally(() => {
      per.clearing = undefined
      per.clearThrough = undefined
      this.drainPending(per)
      this.reportDropped(pluginId, per)
    })
    per.clearing = clearing
    return clearing
  }

  setVerbose(pluginId: string, verbose: boolean): void {
    if (!this.closing)
      this.getOrCreate(pluginId).verboseUntil = verbose
        ? Date.now() + PLUGIN_LOG_VERBOSE_TTL_MS
        : null
  }
  isVerbose(pluginId: string): boolean {
    return this.getState(pluginId).verbose
  }
  getState(pluginId: string): PluginLogState {
    const per = this.per.get(pluginId)
    const expiresAt = per?.verboseUntil ?? null
    if (expiresAt === null || expiresAt <= Date.now()) {
      if (per) per.verboseUntil = null
      return { verbose: false, expiresAt: null }
    }
    return { verbose: true, expiresAt }
  }
  subscribe(listener: LogStreamListener): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private async flushPer(pluginId: string, per: Per): Promise<void> {
    await per.clearing
    await flushDestination(per)
    this.reportDropped(pluginId, per)
    await flushDestination(per)
  }

  /** Flush accepted diagnostics and an explicit summary of overflow losses. */
  async flush(): Promise<void> {
    await Promise.all([...this.per].map(([id, per]) => this.flushPer(id, per)))
  }

  /** Close a quiesced plugin's resources, preserving its persisted diagnostics. */
  release(pluginId: string): Promise<void> {
    const per = this.per.get(pluginId)
    if (!per) return Promise.resolve()
    if (per.releasing) return per.releasing
    per.retiring = true
    let closeStarted = false
    const releasing = (async () => {
      if (per.unavailable) {
        per.unavailable = false
        per.opened = undefined
        void this.ensureOpen(pluginId, per)
      }
      await this.flushPer(pluginId, per)
      const dest = per.dest
      if (dest && !per.destinationClosed) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            dest.off('close', closed)
            dest.off('error', failed)
          }
          const closed = () => {
            cleanup()
            resolve()
          }
          const failed = (error: Error) => {
            cleanup()
            reject(error)
          }
          dest.once('close', closed)
          dest.once('error', failed)
          try {
            closeStarted = true
            dest.end()
          } catch (error) {
            cleanup()
            reject(error)
          }
        })
      }
      per.retired = true
      per.ring = []
      per.ringBytes = 0
      per.pending = []
      per.pendingBytes = 0
      per.logger = undefined
      per.dest = undefined
      if (this.per.get(pluginId) === per) this.per.delete(pluginId)
    })().catch((error) => {
      // Opening/flush failures can retry. SonicBoom destroys itself before
      // closing its FD: a failed close must never re-enable that dead writer
      // or retry a numeric descriptor whose ownership is now uncertain.
      if (!closeStarted) {
        per.retiring = false
        per.releasing = undefined
      }
      throw error
    })
    per.releasing = releasing
    return releasing
  }

  close(): Promise<void> {
    this.closing = true
    this.closePromise ??= Promise.all(
      [...this.per.keys()].map((id) => this.release(id))
    )
      .then(() => {
        this.subscribers.clear()
      })
      .catch((error) => {
        this.closePromise = undefined
        throw error
      })
    return this.closePromise
  }
}
