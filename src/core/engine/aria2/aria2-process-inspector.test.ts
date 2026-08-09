import { describe, expect, it } from 'vitest'
import {
  parseLsofPid,
  parseNetstatPid,
  parseSsPid,
} from './aria2-process-inspector'

describe('Aria2ProcessInspector parsers', () => {
  it('reads the first listener pid from lsof field output', () => {
    expect(parseLsofPid('p4201\np4201\n')).toBe(4201)
    expect(parseLsofPid('')).toBeNull()
  })

  it('reads a listener pid from Linux ss output', () => {
    const output =
      'LISTEN 0 1024 127.0.0.1:16800 0.0.0.0:* users:(("aria2c",pid=7312,fd=8))'
    expect(parseSsPid(output)).toBe(7312)
    expect(parseSsPid('LISTEN 0 1024 127.0.0.1:16800')).toBeNull()
  })

  it('matches only the requested Windows listening port', () => {
    const output = [
      'TCP    127.0.0.1:6800    0.0.0.0:0    LISTENING    91',
      'TCP    127.0.0.1:16800   0.0.0.0:0    LISTENING    3141',
      'TCP    127.0.0.1:16800   127.0.0.1:50000 ESTABLISHED 2718',
    ].join('\r\n')
    expect(parseNetstatPid(output, 16800)).toBe(3141)
    expect(parseNetstatPid(output, 16801)).toBeNull()
  })
})
