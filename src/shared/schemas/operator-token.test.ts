import { describe, expect, it } from 'vitest'
import { isWeakOperatorToken, operatorTokenSchema } from './operator-token'

describe('custom operator tokens', () => {
  it.each([
    '1',
    'abc',
    'password123456',
    '中文短语',
    ' space separated words ',
  ])('accepts user choices without complexity enforcement: %s', (value) => {
    expect(operatorTokenSchema.safeParse(value).success).toBe(true)
  })
  it.each(['', '   ', 'a\nb', 'a\0b', '\ud800', 'a'.repeat(1025)])(
    'rejects unusable input',
    (value) => {
      expect(operatorTokenSchema.safeParse(value).success).toBe(false)
    }
  )
  it('warns about short, repeated and common choices without requiring character classes', () => {
    expect(isWeakOperatorToken('123')).toBe(true)
    expect(isWeakOperatorToken('password123456')).toBe(true)
    expect(isWeakOperatorToken('abcabcabcabcabc')).toBe(true)
    expect(isWeakOperatorToken('orchard railway violet')).toBe(false)
  })
})
