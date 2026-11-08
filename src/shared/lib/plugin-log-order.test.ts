import { describe, expect, it } from 'vitest'
import type { PluginLogEntry } from '../types/plugin'
import { comparePluginLogs, pluginLogSequence } from './plugin-log-order'

describe('plugin log ordering', () => {
  const entry = (ts: number, logSequence?: unknown): PluginLogEntry => ({
    ts,
    logSequence,
    level: 'info',
    msg: 'test',
  })
  it('orders sequenced records by append order and leaves legacy records first', () => {
    const legacy = entry(100)
    const first = entry(200, 1)
    const second = entry(50, 2)
    expect([second, first, legacy].sort(comparePluginLogs)).toEqual([
      legacy,
      first,
      second,
    ])
  })
  it('falls back to timestamps for old records and ignores invalid sequence metadata', () => {
    for (const value of [
      -1,
      0,
      NaN,
      Infinity,
      1.5,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(pluginLogSequence(entry(1, value))).toBeUndefined()
    expect(
      [entry(2), entry(1)].sort(comparePluginLogs).map((item) => item.ts)
    ).toEqual([1, 2])
  })
})
