import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Authority-scoped "may this backend auto-connect now?" state.
 *
 * A Chrome MV3 service worker is routinely restarted. The durable gate keeps a
 * pending pairing from being duplicated after a restart and remembers an
 * operator denial until the user explicitly retries. Remote Motrix Servers
 * must not share either state with the local App or with another Server, so v2
 * stores one row per opaque `BackendAuthority`.
 *
 * The no-argument constructor is an explicit local compatibility facade for
 * the existing local ConnectionManager. Remote integration must construct a
 * module-issued authority and pass it to `forAuthority` (or the constructor).
 */

import {
  assertBackendAuthority,
  type BackendAuthority,
  backendAuthorityKey,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

const STORAGE_KEY = 'motrix.connectionGate'
const STORAGE_VERSION = 2 as const
const DEFAULT_PAIR_PENDING_MS = 90_000
const MAX_LAST_ERROR_LENGTH = 512

export interface ConnectionGateState {
  reason: 'pair-pending' | 'denied' | null
  pausedUntil: number // epoch ms; Number.POSITIVE_INFINITY for `denied`
  lastError: string | null
}

interface PersistedConnectionGateState {
  authorityKey: string
  reason: 'pair-pending' | 'denied'
  pausedUntil: number
  lastError: string | null
}

interface PersistedConnectionGateSetV2 {
  version: typeof STORAGE_VERSION
  states: PersistedConnectionGateState[]
}

type ReadResult =
  | { kind: 'known'; set: PersistedConnectionGateSetV2 }
  | { kind: 'legacy'; set: PersistedConnectionGateSetV2 }
  | { kind: 'future' }
  | { kind: 'corrupt' }

const OPEN: Readonly<ConnectionGateState> = Object.freeze({
  reason: null,
  pausedUntil: 0,
  lastError: null,
})

const CLOSED_UNSUPPORTED: Readonly<ConnectionGateState> = Object.freeze({
  reason: 'denied',
  pausedUntil: Number.POSITIVE_INFINITY,
  lastError: 'connection gate version is unsupported',
})

const CLOSED_CORRUPT: Readonly<ConnectionGateState> = Object.freeze({
  reason: 'denied',
  pausedUntil: Number.POSITIVE_INFINITY,
  lastError: 'connection gate state is corrupt',
})

const LOCAL_AUTHORITY_KEY = backendAuthorityKey(LOCAL_BACKEND_AUTHORITY)
const enqueueConnectionGateOperation = createOperationQueue()

function nowMs(): number {
  return Date.now()
}

function emptySet(): PersistedConnectionGateSetV2 {
  return { version: STORAGE_VERSION, states: [] }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeLastError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length <= MAX_LAST_ERROR_LENGTH
    ? value
    : value.slice(0, MAX_LAST_ERROR_LENGTH)
}

function readState(value: unknown): PersistedConnectionGateState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<PersistedConnectionGateState>
  if (
    !isNonEmptyString(raw.authorityKey) ||
    (raw.reason !== 'pair-pending' && raw.reason !== 'denied')
  ) {
    return null
  }

  if (raw.reason === 'pair-pending') {
    if (
      typeof raw.pausedUntil !== 'number' ||
      !Number.isFinite(raw.pausedUntil)
    ) {
      return null
    }
    return {
      authorityKey: raw.authorityKey,
      reason: raw.reason,
      pausedUntil: raw.pausedUntil,
      lastError: null,
    }
  }

  return {
    authorityKey: raw.authorityKey,
    reason: raw.reason,
    pausedUntil: Number.POSITIVE_INFINITY,
    lastError: normalizeLastError(raw.lastError),
  }
}

function sanitizeStates(value: unknown): PersistedConnectionGateState[] | null {
  if (!Array.isArray(value)) return null
  const byAuthority = new Map<string, PersistedConnectionGateState | null>()
  for (const candidate of value) {
    const candidateAuthorityKey =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as { authorityKey?: unknown }).authorityKey
        : null
    const state = readState(candidate)
    if (state === null) {
      // When a malformed row still identifies its authority, treating it as
      // absent would silently reopen a gate that may have been denied. Preserve
      // availability for unrelated authorities but close this one.
      if (isNonEmptyString(candidateAuthorityKey)) {
        byAuthority.set(candidateAuthorityKey, {
          authorityKey: candidateAuthorityKey,
          reason: 'denied',
          pausedUntil: Number.POSITIVE_INFINITY,
          lastError: 'connection gate state is malformed',
        })
        continue
      }
      // The row cannot be attributed to one authority. Dropping it could
      // silently reopen whichever scope it used to deny, so the whole v2
      // document is unreadable and must be preserved for explicit recovery.
      return null
    }
    if (byAuthority.has(state.authorityKey)) {
      // Choosing one of two rows would let storage order decide whether a gate
      // is open. Close the ambiguous authority and sanitize it on next write.
      byAuthority.set(state.authorityKey, {
        authorityKey: state.authorityKey,
        reason: 'denied',
        pausedUntil: Number.POSITIVE_INFINITY,
        lastError: 'connection gate state is ambiguous',
      })
    } else {
      byAuthority.set(state.authorityKey, state)
    }
  }
  return [...byAuthority.values()].filter(
    (state): state is PersistedConnectionGateState => state !== null
  )
}

function readStoredSet(value: unknown): ReadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'known', set: emptySet() }
  }
  const raw = value as Record<string, unknown>
  if (Object.hasOwn(raw, 'version')) {
    if (raw.version !== STORAGE_VERSION) return { kind: 'future' }
    const states = sanitizeStates(raw.states)
    if (states === null) return { kind: 'corrupt' }
    return {
      kind: 'known',
      set: { version: STORAGE_VERSION, states },
    }
  }

  // The unversioned v1 value was the local gate itself. It contains no remote
  // routing ingredient and therefore migrates only into the local authority.
  const legacy = readState({ ...raw, authorityKey: LOCAL_AUTHORITY_KEY })
  return {
    kind: 'legacy',
    set: {
      version: STORAGE_VERSION,
      states: legacy === null ? [] : [legacy],
    },
  }
}

async function loadSet(forMutation: boolean): Promise<ReadResult> {
  const obj = await browser.storage.local.get(STORAGE_KEY)
  const result = readStoredSet((obj as Record<string, unknown>)[STORAGE_KEY])
  if (forMutation && result.kind === 'future') {
    throw new UnsupportedConnectionGateVersionError()
  }
  if (forMutation && result.kind === 'corrupt') {
    throw new CorruptConnectionGateStateError()
  }
  return result
}

async function persistSet(set: PersistedConnectionGateSetV2): Promise<void> {
  if (set.states.length === 0) {
    await browser.storage.local.remove(STORAGE_KEY)
    return
  }
  await browser.storage.local.set({ [STORAGE_KEY]: set })
}

export class UnsupportedConnectionGateVersionError extends Error {
  constructor() {
    super('connection gate version is unsupported')
  }
}

export class CorruptConnectionGateStateError extends Error {
  constructor() {
    super('connection gate state is corrupt')
  }
}

export class ConnectionGate {
  private readonly authorityKey: string

  constructor()
  constructor(authority: BackendAuthority)
  constructor(...args: [] | [BackendAuthority]) {
    // Preserve the no-argument local facade without allowing an explicitly
    // missing remote authority to fall through into local state.
    const resolved = args.length === 0 ? LOCAL_BACKEND_AUTHORITY : args[0]
    assertBackendAuthority(resolved)
    this.authorityKey = backendAuthorityKey(resolved)
  }

  static forAuthority(authority: BackendAuthority): ConnectionGate {
    return new ConnectionGate(authority)
  }

  async get(): Promise<ConnectionGateState> {
    return enqueueConnectionGateOperation(async () => {
      const result = await loadSet(false)
      if (result.kind === 'future') return { ...CLOSED_UNSUPPORTED }
      if (result.kind === 'corrupt') return { ...CLOSED_CORRUPT }
      if (result.kind === 'legacy') await persistSet(result.set)
      const state = result.set.states.find(
        ({ authorityKey }) => authorityKey === this.authorityKey
      )
      return state === undefined
        ? { ...OPEN }
        : {
            reason: state.reason,
            pausedUntil: state.pausedUntil,
            lastError: state.lastError,
          }
    })
  }

  async pausePending(ttlMs: number = DEFAULT_PAIR_PENDING_MS): Promise<void> {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
      throw new TypeError('connection gate TTL must be finite')
    }
    const state: PersistedConnectionGateState = {
      authorityKey: this.authorityKey,
      reason: 'pair-pending',
      pausedUntil: nowMs() + ttlMs,
      lastError: null,
    }
    await this.replace(state)
  }

  async pauseDenied(lastError: string): Promise<void> {
    const state: PersistedConnectionGateState = {
      authorityKey: this.authorityKey,
      reason: 'denied',
      pausedUntil: Number.POSITIVE_INFINITY,
      lastError: normalizeLastError(lastError),
    }
    await this.replace(state)
  }

  async clear(): Promise<void> {
    return enqueueConnectionGateOperation(async () => {
      const result = await loadSet(true)
      if (result.kind === 'future') {
        throw new UnsupportedConnectionGateVersionError()
      }
      if (result.kind === 'corrupt') {
        throw new CorruptConnectionGateStateError()
      }
      const states = result.set.states.filter(
        ({ authorityKey }) => authorityKey !== this.authorityKey
      )
      if (
        states.length === result.set.states.length &&
        result.kind !== 'legacy'
      ) {
        return
      }
      await persistSet({ version: STORAGE_VERSION, states })
    })
  }

  /**
   * True iff this authority may auto-connect now (open, or an expired pending
   * gate). Expiry is observed without mutating storage so the caller can still
   * display the last durable state until its explicit retry clears it.
   */
  async shouldAutoConnect(): Promise<boolean> {
    const state = await this.get()
    if (state.reason === null) return true
    if (state.reason === 'denied') return false
    return state.pausedUntil <= nowMs()
  }

  private async replace(state: PersistedConnectionGateState): Promise<void> {
    return enqueueConnectionGateOperation(async () => {
      const result = await loadSet(true)
      if (result.kind === 'future') {
        throw new UnsupportedConnectionGateVersionError()
      }
      if (result.kind === 'corrupt') {
        throw new CorruptConnectionGateStateError()
      }
      const states = result.set.states.filter(
        ({ authorityKey }) => authorityKey !== this.authorityKey
      )
      states.push(state)
      await persistSet({ version: STORAGE_VERSION, states })
    })
  }
}
