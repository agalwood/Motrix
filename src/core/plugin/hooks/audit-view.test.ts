import { describe, expect, it } from 'vitest'
import { sanitizeForAudit } from './audit-view'

describe('AuditViewMixin', () => {
  it('strips sourceUrl path + query', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com/a?b=1',
      uris: ['https://cdn.example.com/file?token=secret'],
      saveDir: '/x',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }],
      proxy: 'http://u:p@h:80',
      createdBy: 'user',
      requestedAt: 0,
    })
    expect(v.sourceHost).toBe('https://example.com')
    expect(v.uris).toEqual(['https://cdn.example.com'])
    expect(v.headerNames).toEqual(['Authorization'])
    expect(v.headerValueDigests).toEqual([expect.any(String)])
    expect(v.proxyScheme).toBe('http')
    expect((v as unknown as Record<string, unknown>).sourceUrl).toBeUndefined()
    expect((v as unknown as Record<string, unknown>).proxy).toBeUndefined()
  })

  it('handles invalid uris with try/catch', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com',
      uris: ['https://valid.com', 'not a url', 'ftp://another.org'],
      saveDir: '/x',
      headers: [],
      createdBy: 'user',
      requestedAt: 0,
    })
    expect(v.uris).toEqual(['https://valid.com', '', 'ftp://another.org'])
  })

  it('produces multiple header digests in order', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com',
      uris: [],
      saveDir: '/x',
      headers: [
        { name: 'Authorization', value: 'Bearer token1' },
        { name: 'X-Custom', value: 'value2' },
        { name: 'Cookie', value: 'session=abc123' },
      ],
      createdBy: 'user',
      requestedAt: 0,
    })
    expect(v.headerNames).toEqual(['Authorization', 'X-Custom', 'Cookie'])
    expect(v.headerValueDigests).toHaveLength(3)
    expect(v.headerValueDigests[0]).not.toBe(v.headerValueDigests[1])
    expect(v.headerValueDigests[1]).not.toBe(v.headerValueDigests[2])
  })

  it('headerValueDigests are sha256 hex (64 lowercase chars)', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com',
      uris: [],
      saveDir: '/x',
      headers: [{ name: 'X-Api-Key', value: 'secret-key-12345' }],
      createdBy: 'user',
      requestedAt: 0,
    })
    expect(v.headerValueDigests).toHaveLength(1)
    const digest = v.headerValueDigests[0]
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('proxy undefined when dto.proxy is undefined', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com',
      uris: [],
      saveDir: '/x',
      headers: [],
      createdBy: 'user',
      requestedAt: 0,
    })
    expect(v.proxyScheme).toBeUndefined()
    expect('proxyScheme' in v).toBe(true)
  })

  it('output object does not have headers, proxy, sourceUrl keys', () => {
    const v = sanitizeForAudit({
      type: 'http',
      sourceUrl: 'https://example.com/path',
      uris: [],
      saveDir: '/x',
      headers: [{ name: 'Auth', value: 'secret' }],
      proxy: 'http://proxy.example.com:8080',
      createdBy: 'user',
      requestedAt: 0,
    })
    expect('sourceUrl' in v).toBe(false)
    expect('headers' in v).toBe(false)
    expect('proxy' in v).toBe(false)
  })
})
