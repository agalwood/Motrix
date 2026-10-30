import { describe, expect, it } from 'vitest'
import { TaskCookieError } from '../task-cookie-error'
import { prepareAria2TaskCookies } from './task-cookies'

const cookie = {
  name: 'sid',
  value: 'synthetic-secret',
  domain: '.example.com',
  path: '/',
}
const now = 1_800_000_000_000

describe('published aria2 cookie adaptation', () => {
  it('keeps usable credentials byte-for-byte while projecting fields and filtering incompatible records', () => {
    const input = [
      { ...cookie, sameSite: 'lax', secure: true, httpOnly: true },
      ...['', '中文', 'a b', 'a:b'].map((name) => ({ ...cookie, name })),
      { ...cookie, name: 'unicodeValue', value: '中文=原值' },
    ]
    const before = structuredClone(input)
    const result = prepareAria2TaskCookies(input, now)
    expect(result.cookies).toEqual([
      { ...cookie, secure: true, httpOnly: true },
      { ...cookie, name: 'unicodeValue', value: '中文=原值' },
    ])
    expect(result.discarded.map((d) => d.index)).toEqual([1, 2, 3, 4])
    expect(input).toEqual(before)
    input[0]!.value = 'changed later'
    expect(result.cookies[0]?.value).toBe('synthetic-secret')
  })

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
    { secure: 'true' },
  ])(
    'filters only the incompatible entry and never retains its contents in diagnostics: %j',
    (overrides) => {
      const result = prepareAria2TaskCookies(
        [cookie, { ...cookie, ...overrides }] as never,
        now
      )
      expect(result.cookies).toEqual([cookie])
      expect(result.discarded).toEqual([expect.objectContaining({ index: 1 })])
      expect(JSON.stringify(result.discarded)).not.toContain(cookie.value)
      expect(JSON.stringify(result.discarded)).not.toContain(cookie.domain)
    }
  )

  it('refuses a fully incompatible jar rather than silently creating an anonymous task', () => {
    expect(() =>
      prepareAria2TaskCookies([{ ...cookie, name: '' }], now)
    ).toThrow(TaskCookieError)
    try {
      prepareAria2TaskCookies([{ ...cookie, name: '' }], now)
    } catch (error) {
      expect(error).toMatchObject({ diagnostic: { reason: 'noUsableCookies' } })
      expect(JSON.stringify(error)).not.toContain(cookie.value)
    }
    expect(prepareAria2TaskCookies([], now)).toEqual({
      cookies: [],
      discarded: [],
    })
    expect(
      prepareAria2TaskCookies([{ ...cookie, expiresAt: now }], now)
    ).toMatchObject({ cookies: [], discarded: [{ reason: 'expired' }] })
  })

  it('applies byte limits without truncating multibyte values', () => {
    expect(
      prepareAria2TaskCookies([{ ...cookie, value: 'a'.repeat(4093) }], now)
        .cookies
    ).toHaveLength(1)
    const result = prepareAria2TaskCookies(
      [cookie, { ...cookie, name: 'long', value: 'a'.repeat(4093) }],
      now
    )
    expect(result.cookies).toEqual([cookie])
    expect(result.discarded).toEqual([
      { index: 1, field: 'nameValue', reason: 'size', byteLength: 4097 },
    ])
  })

  it('deduplicates by the engine identity, preserves the last scope and ignores expired entries', () => {
    const result = prepareAria2TaskCookies(
      [
        { ...cookie, domain: '.EXAMPLE.com', path: undefined, hostOnly: false },
        {
          ...cookie,
          domain: 'example.com',
          value: 'last',
          secure: true,
          hostOnly: true,
        },
        { ...cookie, value: 'expired', expiresAt: now - 1 },
        { ...cookie, name: '', expiresAt: 0 },
      ],
      now
    )
    expect(result.cookies).toEqual([
      {
        ...cookie,
        domain: 'example.com',
        value: 'last',
        secure: true,
        hostOnly: true,
      },
    ])
    expect(result.discarded.map((d) => d.reason)).toEqual([
      'duplicate',
      'expired',
      'expired',
    ])
  })

  it('checks final jar capacity without arbitrarily selecting credentials', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      ...cookie,
      name: `c${i}`,
    }))
    expect(
      prepareAria2TaskCookies([...fifty, { ...cookie, name: '' }], now).cookies
    ).toEqual(fifty)
    expect(() => prepareAria2TaskCookies([...fifty, cookie], now)).toThrow(
      TaskCookieError
    )
    expect(
      prepareAria2TaskCookies(Array(301).fill(cookie), now).cookies
    ).toEqual([cookie])
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...cookie,
      name: `c${i}`,
      domain: `host${Math.floor(i / 50)}.example.com`,
    }))
    expect(prepareAria2TaskCookies(many, now).cookies).toEqual(many)
    expect(() => prepareAria2TaskCookies([...many, cookie], now)).toThrow(
      TaskCookieError
    )
  })

  it('filters array holes instead of serializing them as null cookie records', () => {
    const input = Array(2)
    input[1] = cookie
    expect(prepareAria2TaskCookies(input, now)).toMatchObject({
      cookies: [cookie],
      discarded: [{ index: 0, reason: 'type' }],
    })
    expect(() => prepareAria2TaskCookies(null as never, now)).toThrow(
      TaskCookieError
    )
  })
})
