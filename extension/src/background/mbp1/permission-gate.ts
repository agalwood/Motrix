import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Loopback host-permission gate for MBP1 candidate probing
 * (bridge-pairing-protocol.md §4.1): before the extension fetches
 * `http://127.0.0.1:<port>/discovery` on a candidate port, a Manifest V3
 * extension needs host permission for that origin, or the fetch is blocked
 * regardless of what the page/background script otherwise can do.
 *
 * **This gate is only a compatibility check today.** `manifest.config.ts` declares
 * `host_permissions: ['<all_urls>']` as a *required* permission, granted
 * unconditionally at install — and `<all_urls>` already covers
 * `http://127.0.0.1/*`. The loopback origin is therefore deliberately not
 * repeated in `optional_host_permissions`; browsers omit that redundant
 * declaration and may emit a build warning. `<all_urls>` is not being narrowed
 * by this module: it is load-bearing for other
 * features (download takeover against arbitrary URLs, the `cookies`
 * permission, dynamic `scripting` injection), and narrowing it is a separate
 * project with its own regression surface.
 *
 * This gate remains as the check/request seam for a future least-privilege
 * migration. Such a migration must add `http://127.0.0.1/*` to
 * `optional_host_permissions` and call `requestLoopbackPermission()` directly
 * from a user gesture; changing only `host_permissions` would break discovery.
 */
/** `http://127.0.0.1/*` — match patterns carry no port component in either
 *  Chrome or Firefox, so this matches every candidate port MBP1 probes
 *  (`http://127.0.0.1:<port>/discovery`), not just port 80. */
export const LOOPBACK_ORIGINS = { origins: ['http://127.0.0.1/*'] }

/** `true` if the extension currently holds the loopback host permission.
 *  `false` — never a rejection — when the Permissions API itself is absent,
 *  which is the real remaining reason this can differ from `<all_urls>`'s
 *  unconditional grant: older Firefox releases predate `browser.permissions`
 *  entirely. */
export async function hasLoopbackPermission(): Promise<boolean> {
  if (typeof browser.permissions?.contains !== 'function') return false
  return await browser.permissions.contains(LOOPBACK_ORIGINS)
}

/**
 * Prompts for the loopback host permission if it is not already held.
 *
 * This function is intentionally unused while `<all_urls>` is required. Before
 * using it, declare `http://127.0.0.1/*` in `optional_host_permissions`.
 *
 * Per the WebExtension Permissions API, this **must be called synchronously
 * within a user gesture** (a click handler, not a `setTimeout` or a promise
 * continuation several ticks removed from one) — the browser silently
 * auto-denies an out-of-gesture request rather than throwing, so a caller
 * that violates this sees `false` and no prompt, indistinguishable at this
 * layer from the user actually declining.
 */
export async function requestLoopbackPermission(): Promise<boolean> {
  if (typeof browser.permissions?.request !== 'function') return false
  return await browser.permissions.request(LOOPBACK_ORIGINS)
}
