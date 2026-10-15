import { describe, expect, it } from 'vitest'
import { computeVerifiedOrigin } from '@/background/mbp1/verified-origin'

declare const browser: { runtime: { getURL: (path: string) => string } }

// §6.4/§6.7: `verifiedOrigin` must equal, byte for byte, the raw `Origin`
// header Line A's `parseExtensionOrigin` reads off the WebSocket upgrade —
// no trailing slash, no case folding. Both fixtures return the real
// browser.runtime.getURL('/') shape (WITH a trailing slash), so a naive
// implementation that returned it unstripped would fail these immediately.
//
// These drive the real global `URL` — no stub. `computeVerifiedOrigin`
// deliberately does not read `.origin` (opaque for a non-special scheme,
// serializing to the literal string "null" per the WHATWG URL spec — real
// Chrome/Firefox special-case their own extension schemes internally, but
// nothing here should depend on that to even exercise the code under test),
// so `protocol`/`host` parsing is real, spec-conformant `URL` behavior in
// every environment this suite runs in, not something jsdom/Node's `URL`
// has to specially support.
describe('computeVerifiedOrigin', () => {
  it('pins the exact chrome-extension origin, no trailing slash', () => {
    const id = 'abcdefghijklmnopqrstuvwxyzabcdef'
    browser.runtime.getURL = (path: string) => `chrome-extension://${id}${path}`

    expect(computeVerifiedOrigin()).toBe(`chrome-extension://${id}`)
  })

  it('pins the exact moz-extension origin, no trailing slash', () => {
    const uuid = '12345678-90ab-cdef-1234-567890abcdef'
    browser.runtime.getURL = (path: string) => `moz-extension://${uuid}${path}`

    expect(computeVerifiedOrigin()).toBe(`moz-extension://${uuid}`)
  })

  it('does not lowercase or otherwise normalize the id', () => {
    // The server takes the Origin header verbatim; folding case here would
    // silently desynchronize A_id from a mixed-case id (Firefox UUIDs are
    // lowercase in practice, but nothing here should assume that).
    const id = 'AbCdEf12'
    browser.runtime.getURL = (path: string) => `chrome-extension://${id}${path}`

    expect(computeVerifiedOrigin()).toBe(`chrome-extension://${id}`)
  })

  it('matches the measured Safari wire Origin rather than the uppercase runtime UUID', () => {
    browser.runtime.getURL = () =>
      'safari-web-extension://12345678-90AB-CDEF-1234-567890ABCDEF/'
    expect(computeVerifiedOrigin()).toBe(
      'safari-web-extension://12345678-90ab-cdef-1234-567890abcdef'
    )
  })

  it.each([
    'safari-web-extension://app.motrix.safari.extension/',
    'safari-web-extension://null/',
    'safari-web-extension://user@12345678-90AB-CDEF-1234-567890ABCDEF/',
    'safari-web-extension://12345678-90AB-CDEF-1234-567890ABCDEF:80/',
    'safari-web-extension://12345678-90AB-CDEF-1234-567890ABCDEF/path',
    'safari-web-extension://12345678-90AB-CDEF-1234-567890ABCDEF/?query',
    'safari-web-extension://12345678-90AB-CDEF-1234-567890ABCDEF/#hash',
  ])('rejects an invalid Safari runtime root: %s', (root) => {
    browser.runtime.getURL = () => root
    expect(() => computeVerifiedOrigin()).toThrow()
  })

  it('calls getURL with a path that itself carries a trailing slash', () => {
    // Pins the exact trap this function exists to avoid: getURL('') returns
    // the extension root WITH a trailing slash, same as getURL('/') — the
    // function must derive the origin from parsed URL components, not rely
    // on the input already lacking a trailing slash.
    const calls: string[] = []
    browser.runtime.getURL = (path: string) => {
      calls.push(path)
      return `chrome-extension://id${path}`
    }

    computeVerifiedOrigin()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.endsWith('/')).toBe(true)
  })

  it('throws on a result that does not match the expected extension-origin shape', () => {
    // A wrong verifiedOrigin corrupts every downstream MAC silently, by
    // construction — this has to fail here or nowhere. `getURL()` is not
    // expected to ever return something other than this extension's own
    // chrome-extension:/moz-extension: root in practice, but the guard must
    // still catch it if it ever does, rather than quietly computing a wrong
    // Principal.
    browser.runtime.getURL = () => 'https://example.com/'

    expect(() => computeVerifiedOrigin()).toThrow(/unexpected shape/i)
  })
})
