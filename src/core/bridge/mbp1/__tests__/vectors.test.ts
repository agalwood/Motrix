import { describe, expect, it } from 'vitest'
import { loadMbp1Vectors } from './vectors'

describe('mbp1 vector fixture', () => {
  it('loads the five normative groups', () => {
    const v = loadMbp1Vectors()
    expect(v.spake2).toHaveLength(2)
    expect(v.scryptW.expected.w).toMatch(/^[0-9a-f]{64}$/)
    expect(v.reconnect.expected.macClient).toMatch(/^[0-9a-f]{64}$/)
    expect(v.nmTicket.expected.mac).toMatch(/^[0-9a-f]{64}$/)
    expect(v.envelope.expected.frameC2S_seq0.length).toBeGreaterThan(0)
    expect(v.nmTicket.mustReject.length).toBeGreaterThanOrEqual(6)
    expect(v.envelope.mustReject.length).toBeGreaterThanOrEqual(4)
  })
})
