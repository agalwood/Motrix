import path from 'node:path'
import { redactLogFields, truncateLogText } from '@core/log-redact'
import pino, { type DestinationStream, type Logger } from 'pino'
import type { LogEntry, PluginLogCapability } from './interface'

export interface LogCapabilityHostOptions {
  pluginLogsDir: string
  ringSize?: number
}

export type LogStreamListener = (pluginId: string, entry: LogEntry) => void

type LogDestination = ReturnType<typeof pino.destination>

interface Per {
  logger: Logger
  dest: LogDestination
  /**
   * Resolves `true` once the destination owns a file descriptor, `false` if it
   * failed to get one. `pino.destination` creates the parent directories and
   * opens the file asynchronously, so there is no fd in the tick that builds
   * it and early entries sit in SonicBoom's in-memory buffer.
   */
  opened: Promise<boolean>
  ring: LogEntry[]
  verbose: boolean
}

/**
 * Push one destination's buffer to disk. SonicBoom only honours `flush(cb)`
 * when it actually buffers (`minLength > 0`): the callback then fires from the
 * `drain` handler after an `fsync`, which is the only real durability signal
 * it offers. `flushSync()` is not a substitute — it skips the chunk of an
 * in-flight async write, so it can return before that chunk lands.
 */
async function flushDestination(per: Per): Promise<void> {
  if (!(await per.opened)) return
  await new Promise<void>((resolve) => {
    try {
      per.dest.flush(() => resolve())
    } catch {
      // A destroyed or broken destination has nothing left to push. Plugin
      // logging must never take the host down, so report completion instead
      // of propagating: the destination's own 'error' path owns that failure.
      resolve()
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

  private getOrCreate(pluginId: string): Per {
    let entry = this.per.get(pluginId)
    if (entry) return entry
    const dest = pino.destination({
      dest: path.join(
        this.opts.pluginLogsDir,
        pluginId,
        'logs',
        'current.ndjson'
      ),
      sync: false,
      mkdir: true,
      // Buffering is what makes `flush()` verifiable — SonicBoom's flush(cb)
      // is a documented no-op while minLength is 0. periodicFlush bounds how
      // long an entry may sit in memory so someone tailing current.ndjson
      // still sees output without an explicit flush.
      minLength: 4096,
      periodicFlush: 1000,
    })
    const logger = pino({ base: undefined }, dest as DestinationStream)
    // Safe to attach in this tick: with `sync: false` SonicBoom emits 'ready'
    // (and 'error') from the fs.open callback, which cannot run before this
    // synchronous block finishes, so neither event can be missed here.
    const opened = new Promise<boolean>((resolve) => {
      dest.once('ready', () => resolve(true))
      dest.once('error', () => resolve(false))
    })
    entry = { logger, dest, opened, ring: [], verbose: false }
    this.per.set(pluginId, entry)
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
      // integrity remain enforced; the UI shows a red banner while active.
      const safe = fields
        ? redactLogFields(fields, {
            profile: 'plugin',
            verbose: per.verbose,
          })
        : (fields ?? {})
      const safeMessage = truncateLogText(msg)
      const entry: LogEntry = {
        ...safe,
        ts: Date.now(),
        level,
        msg: safeMessage,
      }
      per.ring.push(entry)
      while (per.ring.length > this.opts.ringSize) per.ring.shift()
      per.logger[level]({ ...safe }, safeMessage)
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
    const per = this.per.get(pluginId)
    if (!per) return []
    return per.ring.slice(-limit)
  }

  clear(pluginId: string): void {
    const per = this.per.get(pluginId)
    if (per) per.ring.length = 0
  }

  setVerbose(pluginId: string, verbose: boolean): void {
    this.getOrCreate(pluginId).verbose = verbose
  }

  isVerbose(pluginId: string): boolean {
    return this.per.get(pluginId)?.verbose ?? false
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
    await Promise.all([...this.per.values()].map(flushDestination))
  }
}
