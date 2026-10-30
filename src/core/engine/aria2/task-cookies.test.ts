import { describe, expect, it } from 'vitest'
import { TaskCookieError } from '../task-cookie-error'
import { prepareAria2TaskCookies } from './task-cookies'

const cookie = {
  name: 'sid',
  value: 'synthetic-secret',
  domain: '.example.com',
  path: '/',
}

describe('aria2 cookie admission', () => {
  it.each(['', '中文', 'a b', 'a:b'])(
    'preserves browser name %j with capability negotiation',
    (name) => {
      const input = {
        ...cookie,
        name,
        sameSite: 'lax',
        hostOnly: false,
        expiresAt: 2102444800000,
      }
      expect(prepareAria2TaskCookies([input], true)).toEqual([
        { ...cookie, name, hostOnly: false, expiresAt: 2102444800000 },
      ])
      expect(() => prepareAria2TaskCookies([input], false)).toThrow(
        TaskCookieError
      )
      expect(input).toHaveProperty('sameSite', 'lax')
    }
  )

  it.each([
    { name: '', value: '' },
    { name: '', value: 'sid=secret' },
    { name: 'bad=name' },
    { name: 'a\nb' },
    { value: 'a\0b' },
    { value: 'a\rb' },
    { value: 'a\tb' },
    { value: 'a\x7fb' },
    { value: 'a;b' },
    { path: '' },
    { path: 'relative' },
    { path: '/a;b' },
    { domain: '' },
    { domain: '..example.com' },
    { domain: 'a..com' },
    { domain: 'example.com.' },
    { domain: 'bad/domain' },
    { domain: 'K.com' },
    { name: '\ud800' },
    { value: '\udfff' },
    { expiresAt: -1 },
    { expiresAt: Infinity },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { value: '界'.repeat(1365) },
  ])(
    'rejects incompatible data without retaining credentials: %j',
    (overrides) => {
      try {
        prepareAria2TaskCookies([cookie, { ...cookie, ...overrides }], true)
        expect.fail('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(TaskCookieError)
        expect((error as TaskCookieError).diagnostic.index).toBe(1)
        expect(JSON.stringify(error)).not.toContain(cookie.value)
        expect(JSON.stringify(error)).not.toContain(cookie.domain)
      }
    }
  )

  it('measures UTF-8 bytes, preserves empty jars and does not truncate credentials', () => {
    expect(prepareAria2TaskCookies([], false)).toEqual([])
    expect(
      prepareAria2TaskCookies([{ ...cookie, value: 'a'.repeat(4093) }], true)
    ).toHaveLength(1)
    expect(() =>
      prepareAria2TaskCookies([{ ...cookie, value: 'a'.repeat(4094) }], true)
    ).toThrow()
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...cookie,
      name: `c${i}`,
    }))
    expect(prepareAria2TaskCookies(many, true)).toEqual(many)
    expect(() => prepareAria2TaskCookies([...many, cookie], true)).toThrow()
    expect(() => prepareAria2TaskCookies(many, false)).toThrow()
    expect(
      prepareAria2TaskCookies(Array(300).fill(cookie), false)
    ).toHaveLength(300)
  })
})
