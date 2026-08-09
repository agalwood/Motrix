import { describe, expect, it } from 'vitest'
import { MediaParseError, resolveUri, seqNumberIv } from './segment-plan'

describe('seqNumberIv', () => {
  it('packs the sequence number big-endian into the low 8 bytes', () => {
    const iv = seqNumberIv(1)
    expect(Buffer.from(iv).toString('hex')).toBe(
      '00000000000000000000000000000001'
    )
  })
  it('seq 0 → all zeros', () => {
    expect(Buffer.from(seqNumberIv(0)).toString('hex')).toBe('0'.repeat(32))
  })
})
describe('resolveUri', () => {
  it('resolves relative against the manifest URL', () => {
    expect(resolveUri('https://h/a/p.m3u8', 'seg0.ts')).toBe(
      'https://h/a/seg0.ts'
    )
  })
})
describe('MediaParseError', () => {
  it('carries a code', () => {
    expect(new MediaParseError('unsupported-live', 'x').code).toBe(
      'unsupported-live'
    )
  })
})
