import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOG_LEVEL,
  getLogLevel,
  LOG_LEVEL_RANK,
  parseLogLevel,
  setLogLevel,
} from '@/shared/logLevel'

declare const browser: {
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
    }
  }
}

beforeEach(() => {
  let bag: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in bag ? { [k]: bag[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    bag = { ...bag, ...i }
  })
})

describe('logLevel store', () => {
  it('defaults to info when unset', async () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info')
    expect(await getLogLevel()).toBe('info')
  })
  it('round-trips a set level', async () => {
    await setLogLevel('debug')
    expect(await getLogLevel()).toBe('debug')
  })
  it('falls back to info on an invalid stored value', async () => {
    await browser.storage.local.set({ 'motrix.logLevel': 'bogus' })
    expect(await getLogLevel()).toBe('info')
  })
})

describe('parseLogLevel', () => {
  it('accepts valid levels', () => {
    for (const l of ['silent', 'error', 'warn', 'info', 'debug']) {
      expect(parseLogLevel(l)).toBe(l)
    }
  })
  it('rejects invalid values', () => {
    expect(parseLogLevel('trace')).toBeNull()
    expect(parseLogLevel(undefined)).toBeNull()
    expect(parseLogLevel(3)).toBeNull()
  })
})

describe('LOG_LEVEL_RANK', () => {
  it('orders silent < error < warn < info < debug', () => {
    expect(LOG_LEVEL_RANK.silent).toBeLessThan(LOG_LEVEL_RANK.error)
    expect(LOG_LEVEL_RANK.error).toBeLessThan(LOG_LEVEL_RANK.warn)
    expect(LOG_LEVEL_RANK.warn).toBeLessThan(LOG_LEVEL_RANK.info)
    expect(LOG_LEVEL_RANK.info).toBeLessThan(LOG_LEVEL_RANK.debug)
  })
})
