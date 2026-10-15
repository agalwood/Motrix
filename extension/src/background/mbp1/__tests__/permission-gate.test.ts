import { describe, expect, it } from 'vitest'
import manifestConfig from '#manifest-config'
import {
  hasLoopbackPermission,
  LOOPBACK_ORIGINS,
  requestLoopbackPermission,
} from '@/background/mbp1/permission-gate'

declare const browser: { permissions?: unknown }

// `hasLoopbackPermission`/`requestLoopbackPermission` themselves just forward
// to `browser.permissions.contains`/`.request` — mocking that call and
// asserting it echoes back would only prove the mock works, since the real
// question (does the extension actually need to ask for this permission
// today?) lives in `manifest.config.ts`, not in this module. `<all_urls>`
// already covers `http://127.0.0.1/*` and is granted unconditionally at
// install, so this pins that relationship against the real manifest output
// instead. It also prevents the required loopback access from being repeated
// as an optional permission, which browsers omit with a warning.
describe('loopback permission — real manifest.config.ts output', () => {
  it('host_permissions currently grants the loopback origin via <all_urls>', async () => {
    const manifest = (await manifestConfig({
      command: 'build',
      mode: 'chromium',
    })) as Record<string, unknown>
    const hostPermissions = manifest.host_permissions as string[] | undefined

    expect(hostPermissions).toBeDefined()
    const loopbackPattern = LOOPBACK_ORIGINS.origins[0]
    expect(
      hostPermissions?.some(
        (pattern) => pattern === '<all_urls>' || pattern === loopbackPattern
      )
    ).toBe(true)
  })

  it('does not redundantly repeat required loopback access as optional', async () => {
    const manifest = (await manifestConfig({
      command: 'build',
      mode: 'chromium',
    })) as Record<string, unknown>
    const optionalHostPermissions = manifest.optional_host_permissions as
      | string[]
      | undefined

    expect(optionalHostPermissions ?? []).not.toContain(
      LOOPBACK_ORIGINS.origins[0]
    )
  })
})

// The one branch that genuinely cannot be exercised against anything real
// from a test process: `browser.permissions` predates support in some older
// Firefox releases, so a mock is the right tool specifically for "the API
// itself is absent," not for "what does contains()/request() return."
describe('loopback permission — API absent (older Firefox)', () => {
  it('both report false when browser.permissions does not exist', async () => {
    const original = browser.permissions
    browser.permissions = undefined
    try {
      expect(await hasLoopbackPermission()).toBe(false)
      expect(await requestLoopbackPermission()).toBe(false)
    } finally {
      browser.permissions = original
    }
  })
})
