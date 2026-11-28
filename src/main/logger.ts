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

function rotateLogFile(logFile: string): void {
  const prev = `${logFile}.1`
  try {
    if (fs.existsSync(prev)) fs.unlinkSync(prev)
    fs.renameSync(logFile, prev)
  } catch {
    // Windows 下若备份文件短暂被占用导致重命名失败，则直接截断当前日志避免无限膨胀
    try {
      fs.truncateSync(logFile, 0)
    } catch {
      // 忽略二次容错异常，避免日志故障中断主进程
    }
  }
}

function rotateIfNeeded(logFile: string, maxSize = MAX_LOG_SIZE): void {
  try {
    const stat = fs.statSync(logFile)
    if (stat.size >= maxSize) {
      rotateLogFile(logFile)
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

// 运行期按字节阈值自动轮转日志，避免长时间运行在系统盘持续累积单个超大日志文件
export function createRotatingLogStream(
  logFile: string,
  options: { maxSize?: number } = {}
): {
  write: (chunk: string) => void
  flushSync: () => void
  close: () => void
} {
  const maxSize = options.maxSize ?? MAX_LOG_SIZE
  rotateIfNeeded(logFile, maxSize)

  let fd: number | null = null
  let currentSize = 0

  const openLogFile = (): number | null => {
    try {
      const opened = fs.openSync(logFile, 'a')
      try {
        currentSize = fs.fstatSync(opened).size
      } catch {
        currentSize = 0
      }
      return opened
    } catch {
      return null
    }
  }

  const closeLogFile = (): void => {
    if (fd === null) return
    try {
      fs.closeSync(fd)
    } catch {
      // 忽略关闭异常
    } finally {
      fd = null
    }
  }

  fd = openLogFile()

  return {
    write(chunk: string): void {
      const bytes = Buffer.byteLength(chunk, 'utf8')
      if (fd === null) {
        fd = openLogFile()
        if (fd === null) return
      }
      if (currentSize > 0 && currentSize + bytes > maxSize) {
        closeLogFile()
        rotateLogFile(logFile)
        fd = openLogFile()
        if (fd === null) return
      }
      try {
        fs.writeSync(fd, chunk, null, 'utf8')
        currentSize += bytes
      } catch {
        closeLogFile()
      }
    },
    flushSync(): void {
      // writeSync 已直写内核缓冲区，无需额外缓冲刷新
    },
    close(): void {
      closeLogFile()
    },
  }
}

export function setupLogger(options: {
  level: string
  logDir: string
  isDev: boolean
  maxSize?: number
}): void {
  fs.mkdirSync(options.logDir, { recursive: true })

  const logFile = path.join(options.logDir, 'motrix.log')
  const fileStream = createRotatingLogStream(logFile, {
    maxSize: options.maxSize,
  })

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
