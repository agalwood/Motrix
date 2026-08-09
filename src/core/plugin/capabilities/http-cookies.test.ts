import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CookieJar,
  ensureCookieJarSchema,
  parseSetCookie,
} from './http-cookies'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  ensureCookieJarSchema(db)
  return db
}

describe('parseSetCookie', () => {
  // Test 1: basic name=value
  it('basic name=value returns correct fields with defaults', () => {
    const result = parseSetCookie('foo=bar', 'https://example.com/')
    expect(result).not.toBeNull()
    expect(result?.name).toBe('foo')
    expect(result?.value).toBe('bar')
    expect(result?.domain).toBe('example.com') // bare host, no dot
    expect(result?.path).toBe('/')
    expect(result?.expiresAt).toBeUndefined()
    expect(result?.secure).toBe(false)
    expect(result?.httpOnly).toBe(false)
  })

  // Test 2: full attribute set
  it('parses Domain, Path, Max-Age, Secure, HttpOnly correctly', () => {
    const before = Date.now()
    const result = parseSetCookie(
      'name=value; Domain=.example.com; Path=/api; Max-Age=3600; Secure; HttpOnly',
      'https://www.example.com/'
    )
    const after = Date.now()

    expect(result).not.toBeNull()
    expect(result?.name).toBe('name')
    expect(result?.value).toBe('value')
    expect(result?.domain).toBe('.example.com')
    expect(result?.path).toBe('/api')
    expect(result?.secure).toBe(true)
    expect(result?.httpOnly).toBe(true)
    // expiresAt should be approximately now + 3600s
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(result?.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000)
  })

  // Test 3: cross-domain rejection
  it('rejects Domain=evil.com set from https://bank.com/', () => {
    const result = parseSetCookie(
      'session=abc; Domain=evil.com',
      'https://bank.com/'
    )
    expect(result).toBeNull()
  })

  // Test 4: malformed — no '='
  it('returns null when header has no "=" in name=value part', () => {
    expect(parseSetCookie('noequalssign', 'https://example.com/')).toBeNull()
  })

  // Max-Age=0 signals immediate deletion
  it('Max-Age=0 sets expiresAt to 0 (deletion signal)', () => {
    const result = parseSetCookie(
      'dead=gone; Max-Age=0',
      'https://example.com/'
    )
    expect(result).not.toBeNull()
    expect(result?.expiresAt).toBe(0)
  })

  // Max-Age overrides Expires
  it('Max-Age overrides Expires when both present', () => {
    const before = Date.now()
    const result = parseSetCookie(
      'x=y; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60',
      'https://example.com/'
    )
    expect(result).not.toBeNull()
    // Should use Max-Age, not the old Expires value
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 60 * 1000)
  })

  // Domain without leading dot gets normalized
  it('Domain without leading dot gets normalized to .domain', () => {
    const result = parseSetCookie(
      'a=1; Domain=example.com',
      'https://sub.example.com/'
    )
    expect(result).not.toBeNull()
    expect(result?.domain).toBe('.example.com')
  })
})

describe('CookieJar', () => {
  let db: Database.Database
  let jarA: CookieJar
  let jarB: CookieJar

  beforeEach(() => {
    db = makeDb()
    jarA = new CookieJar(db, 'plugin.A')
    jarB = new CookieJar(db, 'plugin.B')
  })

  // Test 5: captureFromResponseHeaders + cookieHeader round-trip
  it('captureFromResponseHeaders persists cookie; cookieHeader returns value', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['session=abc123'])
    expect(jarA.cookieHeader('https://example.com/')).toBe('session=abc123')
  })

  // Test 6: Domain scope
  it('Domain=.example.com matches api.example.com but not other.test', () => {
    jarA.captureFromResponseHeaders('https://www.example.com/', [
      'foo=1; Domain=.example.com',
    ])
    expect(jarA.cookieHeader('https://api.example.com/')).toBe('foo=1')
    expect(jarA.cookieHeader('https://other.test/')).toBe('')
  })

  // Test 7: Max-Age=0 deletes existing cookie
  it('Max-Age=0 deletes an existing cookie', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['token=secret'])
    expect(jarA.list()).toHaveLength(1)

    jarA.captureFromResponseHeaders('https://example.com/', [
      'token=; Max-Age=0',
    ])
    expect(jarA.list()).toHaveLength(0)
  })

  // Test 8: Secure flag
  it('Secure cookie is sent over https but excluded from http', () => {
    jarA.captureFromResponseHeaders('https://x.com/', ['key=val; Secure'])
    expect(jarA.cookieHeader('https://x.com/')).toBe('key=val')
    expect(jarA.cookieHeader('http://x.com/')).toBe('')
  })

  // Test 9: Cross-plugin isolation
  it('plugin A cookies are invisible to plugin B', () => {
    jarA.captureFromResponseHeaders('https://shared.com/', ['secret=42'])
    expect(jarB.cookieHeader('https://shared.com/')).toBe('')
  })

  // Test 10: Expired cookies excluded
  it('expired cookies (past Expires date) are excluded from cookieHeader', () => {
    jarA.captureFromResponseHeaders('https://example.com/', [
      'old=val; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ])
    expect(jarA.cookieHeader('https://example.com/')).toBe('')
  })

  // Test 11: Path scope
  it('cookie with Path=/api is sent for /api/x but not /other', () => {
    jarA.captureFromResponseHeaders('https://example.com/', [
      'tok=1; Path=/api',
    ])
    expect(jarA.cookieHeader('https://example.com/api/x')).toBe('tok=1')
    expect(jarA.cookieHeader('https://example.com/other')).toBe('')
  })

  // Test 12: Multiple Set-Cookie headers in one call
  it('multiple Set-Cookie headers captured in one call; both returned', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['a=1', 'b=2'])
    const header = jarA.cookieHeader('https://example.com/')
    expect(header).toContain('a=1')
    expect(header).toContain('b=2')
  })

  // Test 13: Path-length-desc ordering
  it('longer-path cookies appear before shorter-path cookies (RFC 6265 §5.4)', () => {
    jarA.captureFromResponseHeaders('https://example.com/', [
      'a=1; Path=/',
      'b=2; Path=/api',
    ])
    // For /api/x: b (path=/api, len=4) should come before a (path=/, len=1)
    const header = jarA.cookieHeader('https://example.com/api/x')
    expect(header).toBe('b=2; a=1')
  })

  // list() helper
  it('list() returns all cookies for the plugin scoped to its pluginId', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['x=1', 'y=2'])
    jarB.captureFromResponseHeaders('https://example.com/', ['z=3'])

    const listA = jarA.list()
    expect(listA).toHaveLength(2)
    expect(listA.every((c) => ['x', 'y'].includes(c.name))).toBe(true)
  })

  // list() excludes expired cookies
  it('list() excludes cookies with a past Expires / Max-Age=-1', () => {
    // Max-Age=-1 signals immediate expiry (expiresAt = 0 → deleted via stmtDelete)
    // Use a past Expires date instead to land an expired row in the DB.
    jarA.captureFromResponseHeaders('https://example.com/', [
      'expired=yes; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'alive=yes',
    ])
    const result = jarA.list()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('alive')
  })

  // clear() helper
  it('clear() removes all cookies for the plugin', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['x=1', 'y=2'])
    jarB.captureFromResponseHeaders('https://example.com/', ['z=3'])

    jarA.clear()
    expect(jarA.list()).toHaveLength(0)
    // Plugin B unaffected
    expect(jarB.list()).toHaveLength(1)
  })

  // Path matching: exact match
  it('exact path match works', () => {
    jarA.captureFromResponseHeaders('https://example.com/', [
      'tok=1; Path=/exact',
    ])
    expect(jarA.cookieHeader('https://example.com/exact')).toBe('tok=1')
    expect(jarA.cookieHeader('https://example.com/exactsuffix')).toBe('')
  })

  // Path matching: root path '/' matches everything
  it("path '/' cookie matches any path", () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['root=1; Path=/'])
    expect(
      jarA.cookieHeader('https://example.com/anything/deeply/nested')
    ).toBe('root=1')
  })

  // Session cookie (no expires) is included
  it('session cookie (no Expires/Max-Age) is always included', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['sess=abc'])
    expect(jarA.cookieHeader('https://example.com/')).toBe('sess=abc')
  })

  // Upsert: capturing same cookie twice updates value
  it('capturing same cookie twice updates the value (upsert)', () => {
    jarA.captureFromResponseHeaders('https://example.com/', ['tok=v1'])
    jarA.captureFromResponseHeaders('https://example.com/', ['tok=v2'])
    expect(jarA.cookieHeader('https://example.com/')).toBe('tok=v2')
    expect(jarA.list()).toHaveLength(1)
  })
})
