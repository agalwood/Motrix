import pino from 'pino'

export type Logger = pino.Logger

let root: pino.Logger = pino({ level: 'info' })

export function initLogger(logger: pino.Logger): void {
  root = logger
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
      const value = Reflect.get(
        child as unknown as Record<PropertyKey, unknown>,
        prop
      )
      return typeof value === 'function' ? value.bind(child) : value
    },
  })
}
