import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Persists the Motrix backend catalogue in browser.storage.local.
 *
 * The local App has a stable, reserved id (`local`). Every Server entry has
 * its own id for selection and a canonical WS/WSS URL for authority construction.
 * The Extension is unreleased, so only the final schema is accepted; obsolete
 * development data is never migrated into a routing or credential authority.
 */

import { createRemoteBackendAuthority } from '@/background/mbp1/backend-authority'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

const STORAGE_KEY = 'motrix.endpointConfig'

export const LOCAL_ENDPOINT_ID = 'local'
export const ENDPOINT_CONFIG_VERSION = 3 as const

export type EndpointProfileState = 'ready' | 'cleanup-pending'

export interface MotrixServerEndpoint {
  id: string
  name: string
  url: string
  revision: number
  state: EndpointProfileState
}

export interface EndpointCleanupTombstone {
  endpointId: string
  canonicalWsBase: string
  invalidatedRevision: number
}

export interface EndpointConfig {
  version: typeof ENDPOINT_CONFIG_VERSION
  activeEndpointId: string
  servers: MotrixServerEndpoint[]
  cleanupTombstones: EndpointCleanupTombstone[]
}

/** Connection- and credential-safe snapshot of one selected backend. */
export type ResolvedEndpointConfig =
  | { mode: 'local' }
  | { mode: 'remote'; remoteUrl: string; endpointId: string; revision: number }

type StoredConfigRead =
  | { kind: 'known'; config: EndpointConfig }
  | { kind: 'obsolete' }
  | { kind: 'future' }
  | { kind: 'corrupt' }

const DEFAULT: EndpointConfig = {
  version: ENDPOINT_CONFIG_VERSION,
  activeEndpointId: LOCAL_ENDPOINT_ID,
  servers: [],
  cleanupTombstones: [],
}

const DEFAULT_SERVER_NAME = 'Motrix Server'

function cloneDefault(): EndpointConfig {
  return { ...DEFAULT, servers: [], cleanupTombstones: [] }
}

function cloneServer(server: MotrixServerEndpoint): MotrixServerEndpoint {
  return { ...server }
}

function cloneTombstone(
  tombstone: EndpointCleanupTombstone
): EndpointCleanupTombstone {
  return { ...tombstone }
}

function cloneConfig(config: EndpointConfig): EndpointConfig {
  return {
    version: ENDPOINT_CONFIG_VERSION,
    activeEndpointId: config.activeEndpointId,
    servers: config.servers.map(cloneServer),
    cleanupTombstones: config.cleanupTombstones.map(cloneTombstone),
  }
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const CONFIG_KEYS = new Set([
  'version',
  'activeEndpointId',
  'servers',
  'cleanupTombstones',
])
const SERVER_KEYS = new Set(['id', 'name', 'url', 'revision', 'state'])
const TOMBSTONE_KEYS = new Set([
  'endpointId',
  'canonicalWsBase',
  'invalidatedRevision',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function normalizeServer(
  value: unknown,
  strict: boolean
): MotrixServerEndpoint | null {
  if (!isPlainRecord(value)) {
    if (strict) throw new Error('server must be an object')
    return null
  }

  if (!hasExactOwnKeys(value, SERVER_KEYS)) {
    if (strict) throw new Error('server fields are invalid')
    return null
  }

  const raw = value as Record<string, unknown>
  // An endpoint id is an authority ingredient. Never trim or otherwise
  // rewrite it into a different security scope.
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '' || id === LOCAL_ENDPOINT_ID) {
    if (strict) throw new Error('server id must be non-empty and not "local"')
    return null
  }
  if (typeof raw.url !== 'string') {
    if (strict) throw new Error('server url must be a string')
    return null
  }

  let url: string
  try {
    // Reuse the only module allowed to issue a remote authority, then persist
    // just its validated ingredients. This keeps the catalogue's endpoint id
    // and WS/WSS base subject to the exact same boundary checks without ever
    // persisting the opaque authority value itself.
    url = createRemoteBackendAuthority({
      endpointId: id,
      wsBase: raw.url,
    }).canonicalWsBase
  } catch (error) {
    if (strict) throw error
    return null
  }

  if (typeof raw.name !== 'string') {
    if (strict) throw new Error('server name must be a string')
    return null
  }
  const name = raw.name.trim() === '' ? DEFAULT_SERVER_NAME : raw.name.trim()
  if (!isSafeRevision(raw.revision)) {
    if (strict) throw new Error('server revision must be a safe integer')
    return null
  }
  if (raw.state !== 'ready' && raw.state !== 'cleanup-pending') {
    if (strict) throw new Error('server state is invalid')
    return null
  }
  return {
    id,
    name,
    url,
    revision: raw.revision,
    state: raw.state,
  }
}

function normalizeTombstone(
  value: unknown,
  strict: boolean
): EndpointCleanupTombstone | null {
  if (!isPlainRecord(value)) {
    if (strict) throw new Error('cleanup tombstone must be an object')
    return null
  }
  if (!hasExactOwnKeys(value, TOMBSTONE_KEYS)) {
    if (strict) throw new Error('cleanup tombstone fields are invalid')
    return null
  }
  const raw = value as Record<string, unknown>
  const endpointId = typeof raw.endpointId === 'string' ? raw.endpointId : ''
  if (endpointId === '' || endpointId === LOCAL_ENDPOINT_ID) {
    if (strict) throw new Error('cleanup tombstone endpoint id is invalid')
    return null
  }
  if (!isSafeRevision(raw.invalidatedRevision)) {
    if (strict) {
      throw new Error(
        'cleanup tombstone invalidated revision must be a safe integer'
      )
    }
    return null
  }
  if (typeof raw.canonicalWsBase !== 'string') {
    if (strict) throw new Error('cleanup tombstone URL must be a string')
    return null
  }
  let canonicalWsBase: string
  try {
    canonicalWsBase = createRemoteBackendAuthority({
      endpointId,
      wsBase: raw.canonicalWsBase,
    }).canonicalWsBase
  } catch (error) {
    if (strict) throw error
    return null
  }
  return {
    endpointId,
    canonicalWsBase,
    invalidatedRevision: raw.invalidatedRevision,
  }
}

function readStoredConfig(value: unknown): StoredConfigRead {
  if (value === undefined) {
    return { kind: 'known', config: cloneDefault() }
  }
  if (!value || typeof value !== 'object') {
    return { kind: 'corrupt' }
  }

  if (!Object.hasOwn(value, 'version')) {
    return { kind: 'obsolete' }
  }
  const version = (value as { version?: unknown }).version
  if (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version >= 0 &&
    version < ENDPOINT_CONFIG_VERSION
  ) {
    return { kind: 'obsolete' }
  }
  if (version !== ENDPOINT_CONFIG_VERSION) {
    return { kind: 'future' }
  }
  try {
    return { kind: 'known', config: normalizeCurrent(value, true) }
  } catch {
    return { kind: 'corrupt' }
  }
}

function normalizeCurrent(value: unknown, strict: boolean): EndpointConfig {
  if (!isPlainRecord(value)) {
    if (strict) throw new Error('endpoint config must be an object')
    return cloneDefault()
  }
  if (!hasExactOwnKeys(value, CONFIG_KEYS)) {
    if (strict) throw new Error('endpoint config fields are invalid')
    return cloneDefault()
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.servers)) {
    if (strict) throw new Error('endpoint config servers must be an array')
    return cloneDefault()
  }
  if (!Array.isArray(raw.cleanupTombstones)) {
    if (strict) {
      throw new Error('endpoint config cleanup tombstones must be an array')
    }
    return cloneDefault()
  }

  const servers: MotrixServerEndpoint[] = []
  const ids = new Set<string>()
  const urls = new Set<string>()
  for (const value of raw.servers) {
    const server = normalizeServer(value, strict)
    if (server === null) continue
    if (ids.has(server.id)) {
      if (strict) throw new Error('server id is duplicated')
      continue
    }
    if (urls.has(server.url)) {
      if (strict) throw new Error('server URL is duplicated')
      continue
    }
    ids.add(server.id)
    urls.add(server.url)
    servers.push(server)
  }

  const cleanupTombstones: EndpointCleanupTombstone[] = []
  const tombstoneIds = new Set<string>()
  const tombstoneUrls = new Set<string>()
  for (const value of raw.cleanupTombstones) {
    const tombstone = normalizeTombstone(value, strict)
    if (tombstone === null) continue
    if (tombstoneIds.has(tombstone.endpointId)) {
      if (strict) throw new Error('cleanup tombstone endpoint id is duplicated')
      continue
    }
    if (
      tombstoneUrls.has(tombstone.canonicalWsBase) ||
      urls.has(tombstone.canonicalWsBase)
    ) {
      if (strict) {
        throw new Error(
          'cleanup tombstone URL conflicts with a configured authority'
        )
      }
      continue
    }
    tombstoneIds.add(tombstone.endpointId)
    tombstoneUrls.add(tombstone.canonicalWsBase)
    cleanupTombstones.push(tombstone)
  }

  for (const server of servers) {
    const tombstone = cleanupTombstones.find(
      (candidate) => candidate.endpointId === server.id
    )
    if (server.state === 'ready') {
      if (tombstone !== undefined) {
        if (strict) {
          throw new Error('ready server cannot retain a cleanup tombstone')
        }
      }
    } else if (
      tombstone === undefined ||
      tombstone.invalidatedRevision + 1 !== server.revision
    ) {
      if (strict) {
        throw new Error(
          'cleanup-pending server must match a tombstone for the prior revision'
        )
      }
    }
  }

  for (const tombstone of cleanupTombstones) {
    const server = servers.find(({ id }) => id === tombstone.endpointId)
    if (
      server !== undefined &&
      (server.state !== 'cleanup-pending' ||
        tombstone.invalidatedRevision + 1 !== server.revision)
    ) {
      if (strict) {
        throw new Error(
          'cleanup tombstone conflicts with the current endpoint profile'
        )
      }
    }
  }

  if (typeof raw.activeEndpointId !== 'string') {
    if (strict) throw new Error('active endpoint id must be a string')
    return cloneDefault()
  }
  const requestedActiveId = raw.activeEndpointId
  if (
    strict &&
    requestedActiveId !== LOCAL_ENDPOINT_ID &&
    !ids.has(requestedActiveId)
  ) {
    throw new Error('active endpoint id is unknown')
  }
  const activeEndpointId =
    requestedActiveId === LOCAL_ENDPOINT_ID
      ? LOCAL_ENDPOINT_ID
      : ids.has(requestedActiveId)
        ? requestedActiveId
        : LOCAL_ENDPOINT_ID

  return {
    version: ENDPOINT_CONFIG_VERSION,
    activeEndpointId,
    servers,
    cleanupTombstones,
  }
}

/** Resolve the currently selected backend, falling back safely to the App. */
export function resolveActiveEndpoint(
  config: EndpointConfig
): ResolvedEndpointConfig {
  return (
    resolveEndpointById(config, config.activeEndpointId) ?? { mode: 'local' }
  )
}

/** Resolve an explicit endpoint id. Unknown ids return null (fail closed). */
export function resolveEndpointById(
  config: EndpointConfig,
  endpointId: string
): ResolvedEndpointConfig | null {
  if (endpointId === LOCAL_ENDPOINT_ID) return { mode: 'local' }
  const server = config.servers.find(({ id }) => id === endpointId)
  if (!server || (server.state ?? 'ready') !== 'ready') return null
  let remoteUrl: string
  try {
    remoteUrl = createRemoteBackendAuthority({
      endpointId: server.id,
      wsBase: server.url,
    }).canonicalWsBase
  } catch {
    return null
  }
  return {
    mode: 'remote',
    remoteUrl,
    endpointId: server.id,
    revision: isSafeRevision(server.revision) ? server.revision : 0,
  }
}

/** Validate and canonicalize a caller-supplied catalogue without writing. */
export function normalizeEndpointConfig(
  config: EndpointConfig
): EndpointConfig {
  if (config.version !== ENDPOINT_CONFIG_VERSION) {
    throw new Error(
      `endpoint config version must be ${ENDPOINT_CONFIG_VERSION}`
    )
  }
  return normalizeCurrent(config, true)
}

/** Fixed fail-closed error that never includes persisted endpoint data. */
export class UnsupportedEndpointConfigVersionError extends Error {
  constructor() {
    super('endpoint config version is unsupported')
  }
}

export class CorruptEndpointConfigStoreError extends Error {
  constructor() {
    super('endpoint config store is corrupt')
  }
}

// All instances address one browser.storage.local key. A module-level queue
// makes the future-version guard and following write atomic relative to every
// EndpointConfigStore instance in this service-worker realm.
const enqueueEndpointConfigOperation = createOperationQueue()

const endpointConfigLifecycleWriterBrand: unique symbol = Symbol(
  'EndpointConfigLifecycleWriter'
)
const issuedEndpointConfigLifecycleWriters = new WeakSet<object>()

/** Nominal durable-write capability. Production construction is restricted
 * to EndpointCatalogService by the import-boundary check; a structurally
 * similar object is rejected at runtime as well. */
export interface EndpointConfigLifecycleWriter {
  readonly [endpointConfigLifecycleWriterBrand]: true
  set(config: EndpointConfig): Promise<void>
}

class IssuedEndpointConfigLifecycleWriter
  implements EndpointConfigLifecycleWriter
{
  readonly [endpointConfigLifecycleWriterBrand] = true as const

  constructor(private readonly owner: EndpointConfigStore) {
    issuedEndpointConfigLifecycleWriters.add(this)
  }

  set(config: EndpointConfig): Promise<void> {
    if (!issuedEndpointConfigLifecycleWriters.has(this)) {
      throw new TypeError('endpoint lifecycle writer was not issued')
    }
    return this.owner.setForIssuedLifecycleWriter(config, this)
  }
}

export class EndpointConfigStore {
  async get(): Promise<EndpointConfig> {
    return this.read(false)
  }

  /** Lifecycle writers and the startup recovery barrier use this stricter
   * read so an opaque future/corrupt document cannot masquerade as an empty
   * local catalogue and then be overwritten or skipped. */
  async getForLifecycleMutation(): Promise<EndpointConfig> {
    return this.read(true)
  }

  private async read(requireKnown: boolean): Promise<EndpointConfig> {
    return enqueueEndpointConfigOperation(async () => {
      const obj = await browser.storage.local.get(STORAGE_KEY)
      const value = (obj as Record<string, unknown>)[STORAGE_KEY]
      const stored = readStoredConfig(value)
      if (stored.kind === 'future') {
        if (requireKnown) throw new UnsupportedEndpointConfigVersionError()
        return cloneDefault()
      }
      if (stored.kind === 'corrupt') {
        if (requireKnown) throw new CorruptEndpointConfigStoreError()
        // Reads expose no selectable remote authority but preserve every byte
        // for a newer writer that understands the schema.
        return cloneDefault()
      }
      if (stored.kind === 'obsolete') {
        await browser.storage.local.remove(STORAGE_KEY)
        return cloneDefault()
      }
      return cloneConfig(stored.config)
    })
  }

  /** Issue the sole nominal production write view. Import/use outside
   * EndpointCatalogService is rejected by scripts/check-imports.mjs. */
  issueLifecycleWriter(): EndpointConfigLifecycleWriter {
    return new IssuedEndpointConfigLifecycleWriter(this)
  }

  /** Test/fixture primitive. Production source is forbidden from calling it. */
  async setForTest(config: EndpointConfig): Promise<void> {
    return this.persist(config)
  }

  async setForIssuedLifecycleWriter(
    config: EndpointConfig,
    writer: EndpointConfigLifecycleWriter
  ): Promise<void> {
    if (!issuedEndpointConfigLifecycleWriters.has(writer)) {
      throw new TypeError('endpoint lifecycle writer was not issued')
    }
    return this.persist(config)
  }

  private async persist(config: EndpointConfig): Promise<void> {
    return enqueueEndpointConfigOperation(async () => {
      const obj = await browser.storage.local.get(STORAGE_KEY)
      const current = readStoredConfig(
        (obj as Record<string, unknown>)[STORAGE_KEY]
      )
      if (current.kind === 'future') {
        throw new UnsupportedEndpointConfigVersionError()
      }
      if (current.kind === 'corrupt') {
        throw new CorruptEndpointConfigStoreError()
      }
      const normalized = normalizeEndpointConfig(config)
      await browser.storage.local.set({ [STORAGE_KEY]: normalized })
    })
  }
}

export { STORAGE_KEY as ENDPOINT_CONFIG_STORAGE_KEY }
