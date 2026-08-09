// TODO: complete E2E in v1.1.
// The core integration test in src/core/bridge/__tests__/integration.test.ts
// covers the full pair → /v1 → submitDownload round-trip against a real
// WebSocketBridgeServer, so the v1 coverage gate is met. Full Playwright
// orchestration of a Chromium-loaded fixture extension + Native Messaging
// host stdin/stdout is deferred to v1.1 — see plan task 28.
import { test } from '@playwright/test'

test.skip('bridge happy path: pair → submit → ack', async () => {
  // Steps (to implement in v1.1):
  // 1. Launch packaged Motrix via _electron.launch
  // 2. Wait for endpoint.json to appear
  // 3. Launch Chromium with the fixture extension loaded unpacked
  // 4. From the extension popup, trigger chrome.runtime.connectNative('app.motrix.bridge')
  // 5. Assert PairRequestDialog opens in Motrix renderer
  // 6. Click Allow
  // 7. Assert the extension receives a 'paired' frame and a stored token
  // 8. Trigger a fake submitDownload from the extension
  // 9. Assert Motrix's submitAck reply
})
