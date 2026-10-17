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

export interface LogCapabilityHostOptions {
  pluginLogsDir: string
  ringSize?: number
}

export type LogStreamListener = (pluginId: string, entry: LogEntry) => void

type LogDestination = ReturnType<typeof pino.destination>

interface Per {
  logger?: Logger
  dest?: LogDestination
  /**
   * Resolves `true` once the destination owns a file descriptor, `false` if it
   * failed to get one. Directory creation and opening are asynchronous;
   * early entries wait until the destination has an owned descriptor.
   */
  opened: Promise<boolean>
  retryOpen?: () => Promise<boolean>
  ring: LogEntry[]
  verboseUntil: number | null
  clearing?: Promise<void>
  queuedWrites: Array<() => void>
  sequence: number
  openingWrites: Array<() => void>
  unavailable: boolean
}

/**
 * Push one destination's buffer to disk. SonicBoom only honours `flush(cb)`
 * when it actually buffers (`minLength > 0`): the callback then fires from the
 * `drain` handler after an `fsync`, which is the only real durability signal
 * it offers. `flushSync()` is not a substitute — it skips the chunk of an
 * in-flight async write, so it can return before that chunk lands.
 */
async function flushDestination(per: Per): Promise<void> {
  if (!(await per.opened) || !per.dest)
    throw new Error('Plugin log file is unavailable')
  const destination = per.dest
  await new Promise<void>((resolve, reject) => {
    try {
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

  constructor(opts: LogCapabilityHostOptions) {
    this.opts = { ringSize: 100, ...opts }
  }

  private logPath(pluginId: string): string {
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(pluginId)) {
      throw new Error('Invalid plugin log identifier')
    }
    return path.join(
      this.opts.pluginLogsDir,
      pluginId,
      'logs',
      'current.ndjson'
    )
  }

  private getOrCreate(pluginId: string): Per {
    let entry = this.per.get(pluginId)
    if (entry) return entry
    const file = this.logPath(pluginId)
    const { entries: ring, needsNewline } = readPluginLogTail(
      file,
      this.opts.ringSize
    )
    entry = {
      opened: Promise.resolve(false),
      ring,
      verboseUntil: null,
      queuedWrites: [],
      openingWrites: [],
      sequence: Math.max(
        0,
        ...ring.map((item) => pluginLogSequence(item) ?? 0)
      ),
      unavailable: false,
    }
    this.per.set(pluginId, entry)
    const per = entry
    per.retryOpen = async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const fd = await new Promise<number>((resolve, reject) => {
          open(file, 'a', (error, descriptor) =>
            error ? reject(error) : resolve(descriptor)
          )
        })
        try {
          // Create the destination only with an owned descriptor. Otherwise a
          // failed open leaves SonicBoom's timer and exit hook using fd=-1.
          const dest = pino.destination({
            // A numeric string preserves descriptor zero through Pino's defaults.
            dest: String(fd),
            sync: false,
            minLength: 4096,
            periodicFlush: 1000,
          })
          dest.on('error', () => {})
          per.dest = dest
          per.logger = pino(
            { base: undefined, timestamp: false, level: 'trace' },
            dest as DestinationStream
          )
          if (needsNewline) dest.write('\n')
        } catch (error) {
          close(fd, () => {})
          throw error
        }
        for (const write of per.openingWrites.splice(0)) write()
        return true
      } catch {
        per.unavailable = true
        per.openingWrites.length = 0
        return false
      }
    }
    per.opened = per.retryOpen()
    return entry
  }

  create(pluginId: string): PluginLogCapability {
    const per = this.getOrCreate(pluginId)
    const push = (
      level: LogEntry['level'],
      msg: string,
      fields?: Record<string, unknown>
    ) => {
      // Spec §7 L2391-2403 — default-redact url / headers / body / paths /
      // storage value. The per-plugin verbose flag (set via SetPluginLogVerbose
      // IPC + LogCapabilityHost.setVerbose) bypasses privacy-value redaction
      // for diagnostic capture, while structural limits and host metadata
      // integrity remain enforced; the UI shows a warning while active.
      const verbose = this.isVerbose(pluginId)
      const safe = fields
        ? redactLogFields(fields, {
            profile: 'plugin',
            verbose,
          })
        : (fields ?? {})
      const safeMessage = verbose ? truncateLogText(msg) : redactLogText(msg)
      const entry: LogEntry = {
        ...safe,
        entryId: randomUUID(),
        logSequence: ++per.sequence,
        ts: Date.now(),
        level,
        msg: safeMessage,
      }
      per.ring.push(entry)
      while (per.ring.length > this.opts.ringSize) per.ring.shift()
      const write = () => {
        if (per.unavailable) return
        if (!per.logger) {
          per.openingWrites.push(write)
          return
        }
        per.logger[level](
          {
            ...safe,
            entryId: entry.entryId,
            logSequence: entry.logSequence,
            time: entry.ts,
          },
          safeMessage
        )
      }
      if (per.clearing) per.queuedWrites.push(write)
      else write()
      for (const listener of this.subscribers) {
        try {
          listener(pluginId, entry)
        } catch {
          // A subscriber crashing must not poison other subscribers
          // or corrupt the ring; IPC forwarders log upstream if needed.
        }
      }
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
    const per = this.getOrCreate(pluginId)
    const count = Number.isFinite(limit)
      ? Math.max(0, Math.min(this.opts.ringSize, Math.floor(limit)))
      : this.opts.ringSize
    return count === 0 ? [] : per.ring.slice(-count)
  }

  clear(pluginId: string): Promise<void> {
    const per = this.getOrCreate(pluginId)
    if (per.clearing) return per.clearing
    if (per.unavailable && per.retryOpen) {
      per.unavailable = false
      per.opened = per.retryOpen()
    }
    const previous = new Set(per.ring)
    const clearing = (async () => {
      await flushDestination(per)
      await fs.truncate(this.logPath(pluginId), 0)
      // Commit the visible clear only after disk success. Entries captured
      // during the operation remain visible and are written after truncation.
      per.ring = per.ring.filter((item) => !previous.has(item))
    })().finally(() => {
      per.clearing = undefined
      for (const write of per.queuedWrites.splice(0)) write()
    })
    per.clearing = clearing
    return clearing
  }

  setVerbose(pluginId: string, verbose: boolean): void {
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

  /**
   * Resolve once every plugin's buffered output is on disk. This is the only
   * durability handle over `current.ndjson` that plugins and the shells have
   * — the UI reads the in-memory ring instead — so the guarantee has to be
   * real rather than a timing guess.
   */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.per.values()].map(async (per) => {
        await per.clearing
        await flushDestination(per)
      })
    )
  }
}
