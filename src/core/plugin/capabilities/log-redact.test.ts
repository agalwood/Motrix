// Spec §7 L2391-2403 — privacy redaction at the capability log boundary.
// Pure transform over the structured-fields object plugins pass to log.{trace,
// debug, info, warn, error, fatal}({...fields}, msg).
import { describe, expect, it } from 'vitest'
import { redactFields } from './log-redact'

describe('redactFields (M6)', () => {
  // -------------------------------------------------------------------------
  // url — origin + pathname only; query and fragment dropped
  // -------------------------------------------------------------------------
  describe('url redaction', () => {
    it('strips query string and fragment from url', () => {
      const out = redactFields({
        url: 'https://api.example.com/v1/data?token=abc123&user=42#frag',
      })
      expect(out.url).toBe('https://api.example.com/v1/data')
    })

    it('preserves origin + pathname when no query/fragment present', () => {
      const out = redactFields({ url: 'https://api.example.com/v1/data' })
      expect(out.url).toBe('https://api.example.com/v1/data')
    })

    it('falls back to the literal string when url is not parseable', () => {
      const out = redactFields({ url: 'not-a-url' })
      expect(out.url).toBe('[unparseable-url]')
    })

    it('redacts url at nested depth too', () => {
      const out = redactFields({
        request: {
          url: 'https://api.example.com/?secret=xyz',
        },
      })
      expect((out.request as { url: string }).url).toBe(
        'https://api.example.com/'
      )
    })
  })

  // -------------------------------------------------------------------------
  // headers and body — dropped entirely in non-verbose mode
  // -------------------------------------------------------------------------
  describe('headers / body removal', () => {
    it('drops a top-level headers field', () => {
      const out = redactFields({
        headers: { authorization: 'Bearer xxx' },
        otherKey: 'kept',
      })
      expect('headers' in out).toBe(false)
      expect(out.otherKey).toBe('kept')
    })

    it('drops a top-level body field', () => {
      const out = redactFields({ body: 'username=alice&password=hunter2' })
      expect('body' in out).toBe(false)
    })

    it('drops nested headers under request/response objects', () => {
      const out = redactFields({
        request: { headers: { x: 1 }, url: 'https://a/b' },
      })
      const req = out.request as { headers?: unknown; url: string }
      expect(req.headers).toBeUndefined()
      expect(req.url).toBe('https://a/b')
    })
  })

  // -------------------------------------------------------------------------
  // file paths — basename only
  // -------------------------------------------------------------------------
  describe('file path redaction', () => {
    it('reduces a unix-style path to its basename', () => {
      const out = redactFields({
        path: '/Users/alice/Downloads/secret-document.pdf',
      })
      expect(out.path).toBe('secret-document.pdf')
    })

    it('reduces a filePath to its basename', () => {
      const out = redactFields({
        filePath: '/home/user/data/foo.txt',
      })
      expect(out.filePath).toBe('foo.txt')
    })

    it('redacts file paths nested inside other objects', () => {
      const out = redactFields({
        task: { filePath: '/var/x/y/z.mp4' },
      })
      expect((out.task as { filePath: string }).filePath).toBe('z.mp4')
    })
  })

  // -------------------------------------------------------------------------
  // storage values — drop value, keep first 32 chars of key
  // -------------------------------------------------------------------------
  describe('storage value redaction', () => {
    it('drops a top-level storageValue field', () => {
      const out = redactFields({
        storageKey: 'session-token',
        storageValue: 'abc123-very-long-secret',
      })
      expect('storageValue' in out).toBe(false)
      expect(out.storageKey).toBe('session-token')
    })

    it('truncates a long storage key to 32 chars + ellipsis', () => {
      const out = redactFields({
        storageKey: 'a'.repeat(50),
      })
      expect(out.storageKey).toBe(`${'a'.repeat(32)}…`)
    })
  })

  // -------------------------------------------------------------------------
  // verbose mode — all redactions bypassed
  // -------------------------------------------------------------------------
  describe('verbose mode bypass', () => {
    it('passes fields through unchanged when verbose=true', () => {
      const input = {
        url: 'https://api.example.com/v1/data?token=abc',
        headers: { authorization: 'Bearer xxx' },
        body: 'payload',
        path: '/etc/passwd',
        storageKey: 'k'.repeat(50),
        storageValue: 'v',
      }
      const out = redactFields(input, true)
      expect(out).toEqual(input)
    })
  })

  // -------------------------------------------------------------------------
  // Idempotence + immutability
  // -------------------------------------------------------------------------
  describe('immutability', () => {
    it('does not mutate the input object', () => {
      const input = {
        url: 'https://a/?q=1',
        headers: { x: 'y' },
        nested: { path: '/a/b/c' },
      }
      const inputClone = JSON.parse(JSON.stringify(input))
      redactFields(input)
      expect(input).toEqual(inputClone)
    })
  })
})
