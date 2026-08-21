import pino from 'pino'
import { redactApplicationLogArguments, redactLogFields } from './log-redact'

export type Logger = pino.Logger

let root: pino.Logger = pino({ level: 'info' })

const LOG_METHODS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
])

export function initLogger(logger: pino.Logger): void {
  root = logger
}

function isLogMethod(logger: pino.Logger, prop: string): boolean {
  if (LOG_METHODS.has(prop)) return true
  try {
    const values = logger.levels?.values as Record<string, unknown> | undefined
    return typeof values?.[prop] === 'number'
  } catch {
    return false
  }
}

function getSafeProperty(logger: pino.Logger, prop: PropertyKey): unknown {
  const value = Reflect.get(
    logger as unknown as Record<PropertyKey, unknown>,
    prop
  )
  if (typeof value !== 'function') return value

  if (typeof prop === 'string' && isLogMethod(logger, prop)) {
    return (...args: unknown[]) =>
      Reflect.apply(value, logger, redactApplicationLogArguments(args))
  }
  if (prop === 'child') {
    return (
      bindings: pino.Bindings,
      options?: pino.ChildLoggerOptions
    ): pino.Logger =>
      wrapLogger(
        logger.child(
          redactLogFields(bindings, { profile: 'application' }),
          options
        )
      )
  }
  if (prop === 'setBindings') {
    return (bindings: pino.Bindings): void => {
      logger.setBindings(redactLogFields(bindings, { profile: 'application' }))
    }
  }
  return value.bind(logger)
}

function wrapLogger(logger: pino.Logger): pino.Logger {
  return new Proxy(logger, {
    get(target, prop) {
      return getSafeProperty(target, prop)
    },
  })
}

// Lazy child logger: resolves `root.child({module})` on every property
// access. This lets modules call `const log = getLogger('foo')` at import
// time and still pick up the real root logger configured later by
// `setupLogger()` in the main process. Without this, core modules import
// before `setupLogger()` runs and cache a child of the default `pino()`
// instance, sending their logs to stdout instead of the configured file
// stream.
export function getLogger(module: string): pino.Logger {
  return new Proxy({} as pino.Logger, {
    get(_target, prop) {
      const child = root.child({ module })
      return getSafeProperty(child, prop)
    },
  })
}
