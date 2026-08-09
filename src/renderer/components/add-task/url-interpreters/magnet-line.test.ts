import { describe, expect, it } from 'vitest'
import { magnetLineInterpreter } from './magnet-line'

describe('magnetLineInterpreter', () => {
  it('detects a valid magnet line', () => {
    const r = magnetLineInterpreter.tryInterpret(
      'magnet:?xt=urn:btih:abcdef1234567890'
    )
    expect(r).toEqual({
      urls: ['magnet:?xt=urn:btih:abcdef1234567890'],
      userNotice: { kind: 'info', messageKey: 'task.add.interpretedMagnet' },
    })
  })

  it('trims whitespace', () => {
    const r = magnetLineInterpreter.tryInterpret(
      '   magnet:?xt=urn:btih:abc   '
    )
    expect(r?.urls).toEqual(['magnet:?xt=urn:btih:abc'])
  })

  it('returns null for non-magnet', () => {
    expect(magnetLineInterpreter.tryInterpret('https://a/b')).toBeNull()
  })

  it('returns null for multi-line input', () => {
    expect(
      magnetLineInterpreter.tryInterpret('magnet:?xt=x\nhttps://a')
    ).toBeNull()
  })

  it('rejects magnet without ? query', () => {
    expect(
      magnetLineInterpreter.tryInterpret('magnet:xt=urn:btih:x')
    ).toBeNull()
  })
})
