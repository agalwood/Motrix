import { EventEmitter } from 'node:events'
import { type PairedClient, PairingService } from '../pairing-service'
import type { TrustedExtensionRegistry } from '../trusted-extension-registry'

/**
 * A `PairingService` test double that honors the real EventEmitter contract —
 * the production class `extends EventEmitter`, and `WebSocketBridgeServer`
 * subscribes to `'revoked'` / `'rotated'` in its constructor to close the
 * matching SSE streams. A plain-object fake without `.on`/`.emit` would throw
 * at construction, so every bridge test shares this faithful double.
 *
 * `byToken` seeds `findByToken` lookups; tests drive revocation/rotation side
 * effects by calling `.emit('revoked' | 'rotated', { identity, … })` on the
 * returned instance.
 */
export function makeFakePairing(
  byToken: Record<string, PairedClient> = {}
): PairingService {
  const fake = Object.assign(new EventEmitter(), {
    load: async () => {},
    issueToken: async () => ({}) as PairedClient,
    findByToken: (token: string) => byToken[token] ?? null,
    revoke: async () => {},
    markActive: () => {},
    listPaired: () => [],
  })
  return fake as unknown as PairingService
}

/**
 * A `PairingService` double that actually stores issued tokens (mint → look up
 * → list), for tests that drive a real pair flow (initialize handshake,
 * device-code approve, e2e). Tokens use a deterministic `tok-N` shape so
 * assertions like `/^tok-/` stay stable. EventEmitter-backed like
 * {@link makeFakePairing}.
 */
export function makeStatefulFakePairing(): PairingService {
  let issued = 0
  const tokens = new Map<string, PairedClient>()
  const fake = Object.assign(new EventEmitter(), {
    load: async () => {},
    issueToken: async (
      identity: PairedClient['identity'],
      name: string
    ): Promise<PairedClient> => {
      const token = `tok-${++issued}`
      const paired: PairedClient = {
        identity,
        token,
        name,
        pairedAt: 0,
        lastActiveAt: null,
      }
      tokens.set(token, paired)
      return paired
    },
    findByToken: (token: string) => tokens.get(token) ?? null,
    revoke: async () => {},
    markActive: () => {},
    listPaired: () => Array.from(tokens.values()),
  })
  return fake as unknown as PairingService
}

/**
 * A REAL {@link PairingService} backed by an in-memory store — for end-to-end
 * tests that need genuine issue/rotate/revoke semantics (and the `'revoked'` /
 * `'rotated'` events they emit), not a stubbed double. Used to prove that a
 * device-code re-pair actually rotates the token and closes the old SSE without
 * any hand-emitted event.
 */
export function makeInMemoryPairing(): PairingService {
  let list: PairedClient[] = []
  return new PairingService({
    load: async () => [...list],
    save: async (next) => {
      list = [...next]
    },
  })
}

export function makeFakeRegistry(): TrustedExtensionRegistry {
  return {
    load: async () => {},
    has: () => true,
    add: async () => {},
    remove: async () => {},
    listManifestIds: () => [],
  } as unknown as TrustedExtensionRegistry
}
