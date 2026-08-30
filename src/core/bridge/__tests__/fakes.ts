import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from '@shared/protocol/bridge'
import {
  MBP1_CREDENTIALS_FILENAME,
  Mbp1CredentialStore,
} from '../credential-store'
import type { PairDialogRequest } from '../mbp1/pair-session'
import type {
  PairingPromptEnqueueResult,
  PairingPromptSessionOutcome,
  PairingPromptSettleResult,
  PairingPromptTerminalOutcome,
} from '../pairing-prompt-controller'
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

/**
 * A REAL {@link Mbp1CredentialStore} on a throwaway directory. Not a double:
 * §6.7's ordering guarantees are the store's, the sessions await them, and a
 * fake would let a broken ordering pass. The caller owns the temp directory
 * only for the life of the test.
 */
export async function makeTempCredentialStore(): Promise<Mbp1CredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'motrix-mbp1-'))
  return Mbp1CredentialStore.load(join(dir, MBP1_CREDENTIALS_FILENAME))
}

/**
 * The §7.1 approval dialog, recorded rather than rendered. A test reads
 * `requests` for the identity tri-state the server resolved and for the pairing
 * code — the same two things the real dialog shows the user.
 */
export interface FakeDialogs {
  requests: PairDialogRequest[]
  /** The most recent request, or a loud failure if none was queued. */
  latest(): PairDialogRequest
  /** The display code of the most recent request. */
  latestCode(): string
  /** How many prompts reached one explicit terminal outcome. */
  closed: number
  /** Settle the newest prompt as an operator denial. */
  dismissLatest(): void
  queue(args: PairDialogRequest): PairingPromptEnqueueResult
}

export function makeFakeDialogs(): FakeDialogs {
  const requests: PairDialogRequest[] = []
  const prompts: Array<{
    live: boolean
    resolve: (outcome: PairingPromptTerminalOutcome) => void
    terminal: Promise<PairingPromptTerminalOutcome>
  }> = []
  const state = { closed: 0 }

  const settle = (
    index: number,
    outcome: PairingPromptTerminalOutcome
  ): PairingPromptSettleResult => {
    const prompt = prompts[index]
    if (prompt === undefined || !prompt.live) {
      return { ok: false, reason: 'unavailable' }
    }
    prompt.live = false
    state.closed += 1
    prompt.resolve(outcome)
    return { ok: true, outcome }
  }

  return {
    requests,
    get closed() {
      return state.closed
    },
    latest() {
      const last = requests.at(-1)
      if (!last) {
        throw new Error('no pairing dialog was queued')
      }
      return last
    },
    latestCode() {
      return this.latest().code
    },
    dismissLatest() {
      const index = prompts.length - 1
      if (index < 0) {
        throw new Error('no pairing dialog was queued')
      }
      settle(index, 'denied')
    },
    queue(args) {
      requests.push(args)
      let resolve!: (outcome: PairingPromptTerminalOutcome) => void
      const terminal = new Promise<PairingPromptTerminalOutcome>((done) => {
        resolve = done
      })
      const index = prompts.length
      prompts.push({ live: true, resolve, terminal })
      return {
        ok: true,
        handle: {
          promptId: `fake-prompt-${index + 1}`,
          published: Promise.resolve('delivered'),
          terminal,
          settle: (outcome: PairingPromptSessionOutcome) => {
            return settle(index, outcome)
          },
        },
      }
    },
  }
}

/**
 * §5's `isOfficialId`, backed by an explicit allowlist. It stands in for the
 * immutable `native-messaging-extensions.json` set — never the NM manifest set
 * and never the user registry, both of which admit user-added ids.
 */
export function makeAllowlist(
  entries: ReadonlyArray<[Browser, string]>
): (browser: Browser, id: string) => boolean {
  const allowed = new Set(entries.map(([browser, id]) => `${browser}:${id}`))
  return (browser, id) => allowed.has(`${browser}:${id}`)
}

/** The six MBP1 `BridgeServerOptions` a test server needs, plus the dialog
 *  fake the pairing code has to be read from. */
export interface Mbp1TestWiring {
  dialogs: FakeDialogs
  options: {
    instanceId: string
    serverGeneration: string
    appVersion: string
    credentials: Mbp1CredentialStore
    isOfficialId: (browser: Browser, id: string) => boolean
    queueMbp1Dialog: (args: PairDialogRequest) => PairingPromptEnqueueResult
  }
}

export const MBP1_TEST_INSTANCE_ID = 'instance-for-tests'
export const MBP1_TEST_SERVER_GENERATION = 'gen-for-tests'
export const MBP1_TEST_APP_VERSION = '2.0.0-test'

/**
 * Wire MBP1 the way a shell will. The six options resolve as a unit — a server
 * missing any one of them refuses both `/pair` and `/v1` — so a suite that
 * wants a working extension WebSocket needs all of them, and spreading this
 * `options` object is the whole of it.
 */
export async function makeMbp1TestWiring(
  allowlist: ReadonlyArray<[Browser, string]> = []
): Promise<Mbp1TestWiring> {
  const dialogs = makeFakeDialogs()
  return {
    dialogs,
    options: {
      instanceId: MBP1_TEST_INSTANCE_ID,
      serverGeneration: MBP1_TEST_SERVER_GENERATION,
      appVersion: MBP1_TEST_APP_VERSION,
      credentials: await makeTempCredentialStore(),
      isOfficialId: makeAllowlist(allowlist),
      queueMbp1Dialog: (args) => dialogs.queue(args),
    },
  }
}
