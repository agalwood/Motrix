import { extensionBrowser as browser } from '@/shared/browser'
/**
 * MBP1 `clientInstallationId` (bridge-pairing-protocol.md §6.4, §6.7).
 *
 * A random opaque tag for this extension *install*. It is a member of
 * `Principal` (§6.7), a field of `pairHello` (§6.1), and one of the four
 * strings bound into `A_id` — so it is inside the SPAKE2 transcript (§6.4).
 * Its only job is to separate multiple installs or browser profiles of the
 * same extension, which is what makes the post-authentication
 * `prunePrincipalExcept` sound: a second profile is a *different* principal
 * and pairs as its own credential instead of pruning the first profile's.
 *
 * It is client-chosen and unauthenticated. The server binds it into the
 * transcript but never trusts it, so nothing here is a security decision.
 *
 * **Never derived from anything fingerprintable.** `crypto.randomUUID()` only —
 * no hardware, locale, timezone, screen, user-agent or installation-time
 * input. A derived value would turn a routing tag into a cross-site
 * identifier, and it would also break the multi-profile story, since two
 * profiles on one machine would derive the same tag and merge into one
 * principal.
 *
 * ## Why first-write-wins has to be enforced by re-reading
 *
 * The naive shape — `get()`, and if absent generate and `set()` — races, and
 * MV3 service workers really do get concurrent invocations. If two flows each
 * generate a different id, one wins the write while the other may already have
 * sent *its* id in `pairHello`. The transcript then binds an id that is not
 * the persisted one, the next reconnect computes a different `principalKey`,
 * and the credential just created is orphaned and permanently unreachable —
 * the user's pairing silently stops working and no retry fixes it, because the
 * stored credential can never be looked up again.
 *
 * So the whole `read → generate-if-absent → write` sequence runs inside one
 * serialized critical section, with the read *inside* it. The queue is
 * module-level rather than per-instance on purpose: a per-instance queue only
 * serializes callers that happen to share an object, and the two racing flows
 * here are independent call sites, not a shared store handle. There is
 * deliberately no class to construct, so there is no way to accidentally
 * create a second queue.
 *
 * After a first write the value is re-read and the *persisted* value returned.
 * `storage.local` offers no compare-and-swap, so a second JS realm (an options
 * page driving pairing directly, rather than messaging the service worker)
 * could still clobber the write; re-reading narrows that residual window to
 * the write itself and guarantees the returned id equals what storage held
 * when the critical section ended, instead of returning a value that was
 * already overwritten.
 *
 * The id is never cleared — not on unpair, not on "Forget". It identifies the
 * install, not the pairing, and regenerating it would make every stored
 * credential of the old principal unreachable, which is the same failure the
 * serialization above exists to prevent.
 */

import { createOperationQueue } from '@/background/mbp1/operation-queue'

const STORAGE_KEY = 'motrix.mbp1.clientInstallationId'

interface StoredClientInstallationId {
  version: 1
  clientInstallationId: string
}

/**
 * A bound on the persisted value. `crypto.randomUUID()` is 36 characters; the
 * cap only exists so a corrupted or oversized storage value cannot bloat every
 * `A_id` and `principalKey` computation from then on.
 */
const MAX_ID_LENGTH = 128

/**
 * Accepts only a printable-ASCII, non-empty, bounded id.
 *
 * This is stricter than the wire's "ASCII string", and deliberately so: the
 * only producer is `crypto.randomUUID()`, so a value with a space, a control
 * character, or a byte >= 0x80 is storage corruption rather than a legitimate
 * id worth preserving. Rejecting it here costs one regeneration; accepting it
 * would throw out of `enc()` (§2 rejects non-ASCII) in the middle of a
 * handshake, on every attempt, forever.
 */
function readStoredId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as Partial<StoredClientInstallationId>
  // A future version is uninterpretable, not merely unexpected.
  if (stored.version !== 1) return null
  const id = stored.clientInstallationId
  if (typeof id !== 'string') return null
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return null
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i)
    if (code < 0x21 || code > 0x7e) return null
  }
  return id
}

async function read(): Promise<string | null> {
  const obj = await browser.storage.local.get(STORAGE_KEY)
  return readStoredId((obj as Record<string, unknown>)[STORAGE_KEY])
}

async function write(clientInstallationId: string): Promise<void> {
  const stored: StoredClientInstallationId = {
    version: 1,
    clientInstallationId,
  }
  await browser.storage.local.set({ [STORAGE_KEY]: stored })
}

/**
 * Module scope, not per instance: the racing callers here are independent call
 * sites rather than holders of a shared object, so only a realm-wide queue
 * closes the race. See `operation-queue.ts`.
 */
const enqueue = createOperationQueue()

/**
 * Returns this install's `clientInstallationId`, generating and persisting one
 * on first use.
 *
 * Stable across service-worker restarts and browser restarts, and never
 * regenerated while a usable value is present. Concurrent callers all receive
 * the same id and exactly one write happens — see the module comment for why
 * that is load-bearing rather than merely tidy.
 */
export async function getClientInstallationId(): Promise<string> {
  return enqueue(async () => {
    const existing = await read()
    if (existing !== null) return existing
    const generated = crypto.randomUUID()
    await write(generated)
    // Return what storage actually holds. `generated` is the fallback only for
    // the pathological case where the write reported success but nothing
    // readable landed.
    return (await read()) ?? generated
  })
}
