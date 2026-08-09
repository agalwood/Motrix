// TODO: complete E2E in v1.1. See pair-and-submit.spec.ts for context.
import { test } from '@playwright/test'

test.skip('bridge revocation: paired extension is rejected on next connect', async () => {
  // Steps (to implement in v1.1):
  // 1. Complete the happy-path pair flow first
  // 2. In Motrix settings → Browser Integration → click Revoke
  // 3. Wait for the renderer to refresh and the entry to disappear
  // 4. Have the extension attempt a new /v1 connection with the old token
  // 5. Assert HTTP 401 on the upgrade
})
