import { extensionBrowser as browser } from '@/shared/browser'

/**
 * MBP1 `verifiedOrigin` (bridge-pairing-protocol.md §6.4, §6.7).
 *
 * `verifiedOrigin` is a member of `Principal` and one of the four strings
 * `buildAId` binds into the SPAKE2 transcript `A_id` (§6.4) — so it must equal,
 * **byte for byte**, what the server derives on its side. Line A's
 * `parseExtensionOrigin` returns `{browser, extensionId, origin}` where
 * `origin` is the raw `Origin` request header, taken verbatim: not
 * lowercased, no trailing-slash handling, no re-serialization. A divergence
 * here does not fail loudly — `A_id`, `RT`, and every MAC just quietly differ
 * from the server's, and both pairing and reconnect fail closed with no
 * indication of why.
 *
 * The trap is one character wide: `browser.runtime.getURL('/')` (equivalently
 * `getURL('')`) returns `chrome-extension://<id>/` **with** a trailing slash,
 * but a WebSocket upgrade's `Origin` header never carries one — it is a
 * scheme+host(+port) tuple by construction (RFC 6454), never a path. This
 * derives the tuple directly from the parsed URL's `protocol`/`host` rather
 * than reading `.origin`: per the WHATWG URL spec, `origin` for a
 * *non-special* scheme (and `chrome-extension:`/`moz-extension:` are not
 * special) is an opaque origin, serialized as the literal string `"null"` —
 * real Chrome and Firefox both register their extension schemes internally
 * and return the real tuple there, but relying on that browser-specific
 * behavior means depending on a deviation from the very spec `URL` is
 * nominally implementing, with no guard against a spec-conformant `"null"`
 * slipping through. Building the tuple from `protocol`/`host` keeps `URL`
 * doing the parsing (still rejects a malformed `getURL()` result) without
 * that dependency. Do not derive this by string-concatenating a scheme onto
 * `browser.runtime.id`, and do not normalize (lowercase, trim) what this
 * returns for Chromium/Firefox — the server does not. Safari is different:
 * Safari 27 was observed returning an uppercase UUID in getURL() and a
 * lowercase UUID in its WebSocket Origin. Only that UUID is case-folded.
 *
 * **Unverified assumption, flagged rather than asserted:** this value is only
 * correct if the browser actually sends an `Origin` header on a WebSocket
 * opened from an extension background/service-worker context — Line A's
 * `parseExtensionOrigin` refuses the upgrade outright when `Origin` is
 * missing or unparseable. RFC 6455 §4.1 makes `Origin` a mandatory field of
 * the client's opening handshake, which is a wire-protocol requirement browser
 * vendors do not treat as extension-context-optional, but that is inference
 * from the spec, not an observation made against a real Firefox build — this
 * has not been exercised against a live Firefox extension background
 * context. Confirming it empirically against a real browser belongs to this
 * project's end-to-end test suite, not this unit-level module.
 */
/**
 * A wrong `verifiedOrigin` is undiagnosable downstream by construction (see
 * the module doc) — it has to fail here or nowhere. This is the shape every
 * value this function can legitimately produce matches; anything else (most
 * concretely, the literal string `"null"` an opaque-origin serialization
 * would produce) means the derivation above is no longer valid for this
 * runtime and must not be allowed to silently corrupt every MAC downstream.
 */
const VERIFIED_ORIGIN_SHAPE = /^(chrome|moz)-extension:\/\/[^/]+$/

export function computeVerifiedOrigin(): string {
  const root = new URL(browser.runtime.getURL('/'))
  if (root.protocol === 'safari-web-extension:') {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        root.hostname
      ) ||
      root.username !== '' ||
      root.password !== '' ||
      root.port !== '' ||
      root.pathname !== '/' ||
      root.search !== '' ||
      root.hash !== ''
    ) {
      throw new Error('computeVerifiedOrigin: unexpected Safari root')
    }
    return `${root.protocol}//${root.hostname.toLowerCase()}`
  }
  const origin = `${root.protocol}//${root.host}`
  if (!VERIFIED_ORIGIN_SHAPE.test(origin)) {
    throw new Error(`computeVerifiedOrigin: unexpected shape "${origin}"`)
  }
  return origin
}
