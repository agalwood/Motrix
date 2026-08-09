import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { initLogger } from '@core/logger'
import pino from 'pino'
import type pinoPrettyType from 'pino-pretty'

// pino-pretty is a dev-only dep. Lazy-require it so packaged builds
// never traverse the pump → once → wrappy chain (electron-builder 26
// + pnpm hoisted layout occasionally drops deduped grandchildren
// from the asar). We use __filename instead of import.meta.url here
// because Vite's cjs lib output emits import.meta.url as undefined.
const lazyRequire = createRequire(__filename)

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5 MB

function rotateIfNeeded(logFile: string): void {
  try {
    const stat = fs.statSync(logFile)
    if (stat.size > MAX_LOG_SIZE) {
      const prev = `${logFile}.1`
      if (fs.existsSync(prev)) fs.unlinkSync(prev)
      fs.renameSync(logFile, prev)
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

export function setupLogger(options: {
  level: string
  logDir: string
  isDev: boolean
}): void {
  fs.mkdirSync(options.logDir, { recursive: true })

  const logFile = path.join(options.logDir, 'motrix.log')
  rotateIfNeeded(logFile)

  // sync writes during dev so polling/createTask logs land immediately
  // for live diagnosis. Production keeps async for throughput.
  const fileStream = pino.destination({ dest: logFile, sync: options.isDev })

  const streams: pino.StreamEntry[] = [
    { level: 'trace' as const, stream: fileStream },
  ]

  if (options.isDev) {
    const pinoPretty = lazyRequire('pino-pretty') as typeof pinoPrettyType
    streams.push({
      level: 'debug' as const,
      stream: pinoPretty({ colorize: true, translateTime: 'HH:MM:ss.l' }),
    })
  }

  const logger = pino(
    { level: options.isDev ? 'debug' : options.level },
    pino.multistream(streams)
  )

  initLogger(logger)
}
