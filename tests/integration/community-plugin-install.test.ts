// tests/integration/community-plugin-install.test.ts
//
// Plan H milestone M3: manual smoke that a community plugin (built via
// @motrix/plugin-cli init + pack and published as a GitHub Release .moext)
// installs from a real network URL and exercises beforeCreate end-to-end.
//
// Skipped in CI — needs MOTRIX_E2E_NETWORK=1 + a published reference
// plugin (e.g. motrix-app/motrix-example-bilibili-resolver). Run manually
// before each release cycle to dogfood the install path.

import { describe, it } from 'vitest'

describe.skip('Community plugin install via GitHub (M3, manual)', () => {
  it('installs motrix-example-bilibili-resolver from GH and rewrites a URL', () => {
    // Manual procedure:
    //   1. Build reference plugin: pnpm exec motrix-plugin pack in
    //      motrix-example-bilibili-resolver/.
    //   2. Upload .moext to a GH Release.
    //   3. Launch Motrix with MOTRIX_E2E_NETWORK=1; install via the
    //      "Install plugin from URL" dialog with the release asset URL.
    //   4. Confirm the consent dialog, then enqueue a bilibili URL and
    //      assert beforeCreate rewrites it via the community plugin's
    //      resolve.
  })
})
