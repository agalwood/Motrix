import { describe, expect, it } from 'vitest'
import { generateRpcSecret } from './rpc-secret'

describe('generateRpcSecret', () => {
  it('returns 8 chars by default', () => {
    expect(generateRpcSecret()).toHaveLength(8)
  })

  it('returns the requested length', () => {
    expect(generateRpcSecret(16)).toHaveLength(16)
    expect(generateRpcSecret(32)).toHaveLength(32)
  })

  it('uses only alphabet characters', () => {
    const allowed =
      /^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]+$/
    for (let i = 0; i < 50; i++) {
      expect(generateRpcSecret(20)).toMatch(allowed)
    }
  })

  it('produces different output across calls', () => {
    const samples = new Set<string>()
    for (let i = 0; i < 50; i++) samples.add(generateRpcSecret(8))
    // 50 random 8-char samples — collision probability is astronomically low
    expect(samples.size).toBeGreaterThan(45)
  })
})
