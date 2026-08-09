// TODO: complete E2E in v1.1.
// The core integration test in
// src/core/bridge-receiver/__tests__/integration.test.ts covers the full
// pair → /v1 → submitDownload(direct) → file-on-disk round-trip against a
// real WebSocketBridgeServer with machine-replay verification. Full
// Playwright orchestration of a Chromium-loaded fixture extension +
// Native Messaging host stdin/stdout is deferred to v1.1 — mirrors the
// existing pair-and-submit.spec.ts precedent.
import { test } from '@playwright/test'

test.skip('bridge receiver direct: pair → submit → file lands', async () => {
  // Steps (to implement in v1.1, alongside pair-and-submit.spec.ts):
  // 1. Launch packaged Motrix via _electron.launch
  // 2. Wait for endpoint.json to appear
  // 3. Launch Chromium with the fixture extension loaded unpacked
  // 4. Trigger pair flow from the fixture popup
  // 5. Click Allow in PairRequestDialog
  // 6. From the fixture popup, send a submitDownload(direct) frame
  //    pointing at the local fixture server's mp4 URL
  // 7. Assert Motrix's submitAck reply
  // 8. Assert the file lands in the default saveDir
  // 9. Assert the extension popup shows the completed state
})
