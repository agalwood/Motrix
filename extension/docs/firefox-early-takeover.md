# Firefox early takeover

The blocking webRequest listener has two phases. It holds response headers only
for a bounded, read-only preflight (1.5 seconds). It checks configuration,
endpoint availability, response metadata, and the same automatic takeover policy
as the native download adapter. Failure or timeout returns `{}` without starting
any replacement transfer. A successful preflight returns `{ cancel: true }` and
schedules delivery in a later task; it does not await a confirmation form inside
the blocking listener.

The independent `motrix.earlyTakeover` setting defaults to enabled. The normal
`motrix.takeoverConfig.enabled` setting defaults to disabled through the existing
configuration store. Startup waits for the initial read within the preflight
budget; a newer storage event must not be overwritten by that read. Settings and
endpoint changes fence pending delivery.

Automatic downloads keep `origin: 'auto'` for policy, pairing, and submission
semantics. `nativeDownloadCancelled: true` records the separate fact that early
interception already cancelled the response. This flag survives confirmation
session recovery and makes the explicit browser action start a new download.
Ordinary native confirmations continue to preserve their existing response.

## Ownership after cancellation

| Outcome | Owner/action |
| --- | --- |
| Direct accepted | Motrix; presentation failure cannot replay |
| Direct unknown | Motrix may own it; do not replay |
| Direct browser | Handoff already replayed; do not replay again |
| Direct skipped/failed | Attempt browser replay once |
| Confirm accepted | Confirmation submission owns it |
| Confirm browser | Confirmation browser action replays once |
| Confirm cancel/expiry | No replacement download |
| Confirmation unavailable/unsupported | Discard any early draft; attempt browser replay once |

Browser fallback caches its attempt, including rejection. Requests without a tab
and extension-initiated requests are excluded from early interception. The native
adapter also ignores its own extension's DownloadItems. There is no URL-based
TTL: two user downloads of the same URL are separate operations.

PDF and other inline responses are left alone unless explicitly attachments.
Only GET 2xx main-frame, sub-frame attachment, or binary object responses qualify;
media, POST, and other request types stay on the existing path.

## Validation

- `src/background/interception/__tests__/webRequestEarly.test.ts` covers actual
  policy and handoff code, startup/live switches, cancellation before delivery,
  browser fallback ownership, unknown outcomes, and repeated URLs.
- Confirmation tests cover replay only on browser choice, failed-popup draft
  cleanup, and cancelled-response ownership across background restart.
- `node scripts/verify-firefox-takeover.mjs` registers **both** production Firefox
  adapters with real webRequest/download APIs and a local HTTP server. It checks
  native download counts, GET counts, a quiet confirmation interval, explicit
  browser replay, failed/unknown submission, missing Content-Type, defaults,
  exclusions, size rules, PDF, and the kill switch. Motrix and confirmation UI
  interaction are simulated; the production confirmation service/actions run.
- Existing CI executes that script on Firefox 143.0 and latest.

A strictly one-use URL cannot be replayed reliably by Motrix or by a browser
fallback after cancellation. This API cannot transfer an already-open browser
response to Motrix. Sites requiring that behavior must remain browser-owned via
site exclusion or the early kill switch; tests passing do not remove this
protocol limitation.
