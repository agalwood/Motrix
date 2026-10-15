import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import type {
  EndpointCleanupTombstone,
  EndpointConfig,
  EndpointConfigLifecycleWriter,
  MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import {
  type EndpointConfigStore,
  LOCAL_ENDPOINT_ID,
  resolveActiveEndpoint,
  resolveEndpointById,
} from '@/background/EndpointConfigStore'
import {
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'
import { normalizeRemoteEndpoint } from '@/shared/endpoint'

export interface EndpointCatalogServiceOptions {
  createId?: () => string
  beforeConnectionChange?: () => void | Promise<void>
  afterConnectionChange?: () => void | Promise<void>
  coordinator?: BackendOperationCoordinator
}

/** Required production dependency: endpoint retirement is never allowed to
 * silently degrade to credential-only cleanup. */
export interface AuthorityRetirementService {
  retire(authority: RemoteBackendAuthority): Promise<void>
}

export interface BackendAttemptLease {
  readonly kind: 'remote-backend-attempt-lease'
}

const backendAttemptMutationCapabilityBrand: unique symbol = Symbol(
  'BackendAttemptMutationCapability'
)
const issuedBackendAttemptMutationCapabilities = new WeakSet<object>()

/** Nominal, lease-bound durable mutation capability. Only this module can
 * issue one; storage modules must not accept structural `{ run() {} }`
 * substitutes from production orchestration. */
export interface BackendAttemptMutationCapability {
  readonly [backendAttemptMutationCapabilityBrand]: true
  run<T>(operation: (attempt: CurrentBackendAttempt) => Promise<T>): Promise<T>
}

export function assertBackendAttemptMutationCapability(
  capability: BackendAttemptMutationCapability
): void {
  if (
    typeof capability !== 'object' ||
    capability === null ||
    !issuedBackendAttemptMutationCapabilities.has(capability)
  ) {
    throw new TypeError('backend attempt mutation capability was not issued')
  }
}

export interface CurrentBackendAttempt {
  readonly authority: RemoteBackendAuthority | typeof LOCAL_BACKEND_AUTHORITY
  readonly endpointId: string
  readonly canonicalWsBase: string | null
  readonly revision: number
}

interface BackendAttemptLeaseSnapshot {
  readonly endpointId: string
  readonly canonicalWsBase: string | null
  readonly revision: number
  /** Process-lifetime incarnation fence. A lease itself cannot survive a
   * service-worker restart, but delete + same-id/same-URL re-add can happen
   * while the old opaque object is still live in this realm. */
  readonly incarnationGeneration: number
}

const issuedAttemptLeases = new WeakMap<object, BackendAttemptLeaseSnapshot>()
const endpointIncarnationGenerations = new Map<string, number>()

function endpointIncarnationGeneration(endpointId: string): number {
  return endpointIncarnationGenerations.get(endpointId) ?? 0
}

function invalidateEndpointIncarnation(endpointId: string): void {
  const current = endpointIncarnationGeneration(endpointId)
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new Error('endpoint lifecycle incarnation is exhausted')
  }
  endpointIncarnationGenerations.set(endpointId, current + 1)
}

export class InvalidBackendAttemptLeaseError extends Error {
  constructor() {
    super('backend attempt lease was not issued by the lifecycle service')
  }
}

export class StaleBackendAttemptLeaseError extends Error {
  constructor() {
    super('backend attempt lease is stale')
  }
}

export class RemoteBackendAttemptRequiredError extends Error {
  constructor() {
    super('a ready backend is required')
  }
}

export class EndpointCleanupPendingError extends Error {
  constructor() {
    super('server cleanup is still pending')
  }
}

/**
 * Serializes catalogue mutations and couples them to credential cleanup.
 * UI callers use intent-specific methods so a stale Popup cannot overwrite a
 * Server added from Options merely by switching the active backend.
 */
export class EndpointCatalogService {
  private readonly endpointConfigWriter: EndpointConfigLifecycleWriter
  private readonly createId: () => string
  private readonly beforeConnectionChange: () => void | Promise<void>
  private readonly afterConnectionChange: () => void | Promise<void>
  private readonly coordinator: BackendOperationCoordinator
  private readonly retireAuthority: (
    authority: RemoteBackendAuthority
  ) => Promise<void>

  constructor(
    private readonly endpointConfigStore: EndpointConfigStore,
    retirementService: AuthorityRetirementService,
    options: EndpointCatalogServiceOptions = {}
  ) {
    this.endpointConfigWriter = endpointConfigStore.issueLifecycleWriter()
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.beforeConnectionChange =
      options.beforeConnectionChange ?? (() => undefined)
    this.afterConnectionChange =
      options.afterConnectionChange ?? (() => undefined)
    this.coordinator = options.coordinator ?? new BackendOperationCoordinator()
    this.retireAuthority = (authority) => retirementService.retire(authority)
  }

  /** Capture one immutable backend profile incarnation. The opaque lease is
   * useful across network awaits but proves nothing until revalidated below. */
  async issueBackendAttemptLease(
    endpointId?: string
  ): Promise<BackendAttemptLease> {
    return this.enqueue(async () => {
      const config = await this.endpointConfigStore.getForLifecycleMutation()
      const endpoint =
        endpointId === undefined
          ? resolveActiveEndpoint(config)
          : resolveEndpointById(config, endpointId)
      if (
        endpoint === null ||
        (endpointId === undefined &&
          endpoint.mode === 'local' &&
          config.activeEndpointId !== LOCAL_ENDPOINT_ID)
      ) {
        throw new RemoteBackendAttemptRequiredError()
      }
      const lease = Object.freeze({
        kind: 'remote-backend-attempt-lease' as const,
      })
      issuedAttemptLeases.set(lease, {
        endpointId:
          endpoint.mode === 'local' ? LOCAL_ENDPOINT_ID : endpoint.endpointId,
        canonicalWsBase: endpoint.mode === 'local' ? null : endpoint.remoteUrl,
        revision: endpoint.mode === 'local' ? 0 : endpoint.revision,
        incarnationGeneration: endpointIncarnationGeneration(
          endpoint.mode === 'local' ? LOCAL_ENDPOINT_ID : endpoint.endpointId
        ),
      })
      return lease
    })
  }

  /** Revalidate immediately before and for the full duration of one bounded
   * durable mutation. Catalogue edit/delete uses the same coordinator, so no
   * lifecycle change can slip between this check and the callback's write. */
  async runWithBackendAttemptLease<T>(
    lease: BackendAttemptLease,
    operation: (attempt: CurrentBackendAttempt) => Promise<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      const snapshot =
        typeof lease === 'object' && lease !== null
          ? issuedAttemptLeases.get(lease)
          : undefined
      if (snapshot === undefined) throw new InvalidBackendAttemptLeaseError()

      const config = await this.endpointConfigStore.getForLifecycleMutation()
      const endpoint = resolveEndpointById(config, snapshot.endpointId)
      if (
        endpoint === null ||
        (endpoint.mode === 'local'
          ? snapshot.canonicalWsBase !== null || snapshot.revision !== 0
          : endpoint.remoteUrl !== snapshot.canonicalWsBase ||
            endpoint.revision !== snapshot.revision) ||
        endpointIncarnationGeneration(snapshot.endpointId) !==
          snapshot.incarnationGeneration
      ) {
        throw new StaleBackendAttemptLeaseError()
      }
      const authority =
        endpoint.mode === 'local'
          ? LOCAL_BACKEND_AUTHORITY
          : createRemoteBackendAuthority({
              endpointId: endpoint.endpointId,
              wsBase: endpoint.remoteUrl,
            })
      return operation(
        Object.freeze({
          authority,
          endpointId:
            endpoint.mode === 'local' ? LOCAL_ENDPOINT_ID : endpoint.endpointId,
          canonicalWsBase:
            endpoint.mode === 'local' ? null : endpoint.remoteUrl,
          revision: endpoint.mode === 'local' ? 0 : endpoint.revision,
        })
      )
    })
  }

  bindBackendAttemptLease(
    lease: BackendAttemptLease,
    guard: (attempt: CurrentBackendAttempt) => void = () => undefined
  ): BackendAttemptMutationCapability {
    if (
      typeof lease !== 'object' ||
      lease === null ||
      !issuedAttemptLeases.has(lease)
    ) {
      throw new InvalidBackendAttemptLeaseError()
    }
    return new IssuedBackendAttemptMutationCapability(this, lease, guard)
  }

  async activate(endpointId: string): Promise<{
    config: EndpointConfig
    activeChanged: boolean
  }> {
    return this.enqueue(async () => {
      const previous = await this.endpointConfigStore.getForLifecycleMutation()
      if (resolveEndpointById(previous, endpointId) === null) {
        throw new Error(`unknown endpoint: ${endpointId}`)
      }
      if (previous.activeEndpointId === endpointId) {
        return { config: previous, activeChanged: false }
      }
      await this.beforeConnectionChange()
      await this.endpointConfigWriter.set({
        ...previous,
        activeEndpointId: endpointId,
      })
      const config = await this.endpointConfigStore.getForLifecycleMutation()
      await this.afterConnectionChange()
      return { config, activeChanged: true }
    })
  }

  async addServer(input: { name: string; url: string }): Promise<{
    config: EndpointConfig
    server: MotrixServerEndpoint
  }> {
    return this.enqueue(async () => {
      const previous = await this.endpointConfigStore.getForLifecycleMutation()
      const canonicalUrl = normalizeRemoteEndpoint(input.url)
      this.assertUrlAvailable(previous, canonicalUrl)

      const server: MotrixServerEndpoint = {
        id: this.createId(),
        name: input.name,
        url: canonicalUrl,
        revision: 0,
        state: 'ready',
      }
      if (previous.servers.some(({ id }) => id === server.id)) {
        throw new Error(`server id already exists: ${server.id}`)
      }
      this.assertEndpointAvailable(previous, server.id, server.url)
      await this.endpointConfigWriter.set({
        ...previous,
        servers: [...previous.servers, server],
      })
      const config = await this.endpointConfigStore.getForLifecycleMutation()
      const normalizedServer = config.servers.find(({ id }) => id === server.id)
      if (!normalizedServer) throw new Error('failed to add server')
      return { config, server: normalizedServer }
    })
  }

  async updateServer(
    endpointId: string,
    expected: Pick<MotrixServerEndpoint, 'name' | 'url' | 'revision'>,
    changes: Pick<MotrixServerEndpoint, 'name' | 'url'>
  ): Promise<{
    config: EndpointConfig
    server: MotrixServerEndpoint
    urlChanged: boolean
    active: boolean
  }> {
    return this.enqueue(async () => {
      const previous = await this.endpointConfigStore.getForLifecycleMutation()
      const existing = this.requireServer(previous, endpointId)
      this.assertExpected(existing, expected)
      this.assertMutable(existing)
      const canonicalUrl = normalizeRemoteEndpoint(changes.url)
      this.assertUrlAvailable(previous, canonicalUrl, endpointId)
      const urlChanged = normalizeRemoteEndpoint(existing.url) !== canonicalUrl
      const active = previous.activeEndpointId === endpointId

      const candidate: MotrixServerEndpoint = {
        ...existing,
        name: changes.name,
        url: canonicalUrl,
      }
      if (!urlChanged) {
        const servers = previous.servers.map((current) =>
          current.id === endpointId ? candidate : current
        )
        await this.endpointConfigWriter.set({ ...previous, servers })
        const next = await this.endpointConfigStore.getForLifecycleMutation()
        const server = this.requireServer(next, endpointId)
        return {
          config: next,
          server,
          urlChanged,
          active,
        }
      }

      if (existing.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('server revision is exhausted')
      }

      if (active) await this.beforeConnectionChange()
      invalidateEndpointIncarnation(endpointId)
      await this.endpointConfigWriter.set(
        this.withPendingCleanup(
          previous,
          {
            ...candidate,
            revision: existing.revision + 1,
            state: 'cleanup-pending',
          },
          {
            endpointId,
            canonicalWsBase: existing.url,
            invalidatedRevision: existing.revision,
          }
        )
      )
      await this.retireAuthority(
        createRemoteBackendAuthority({
          endpointId,
          wsBase: existing.url,
        })
      )
      await this.endpointConfigWriter.set(
        this.finishCleanup(
          await this.endpointConfigStore.getForLifecycleMutation(),
          endpointId
        )
      )
      const next = await this.endpointConfigStore.getForLifecycleMutation()
      if (active) await this.afterConnectionChange()
      const server = this.requireServer(next, endpointId)
      return {
        config: next,
        server,
        urlChanged,
        active,
      }
    })
  }

  async removeServer(
    endpointId: string,
    expected: Pick<MotrixServerEndpoint, 'name' | 'url' | 'revision'>
  ): Promise<{
    config: EndpointConfig
    wasActive: boolean
  }> {
    return this.enqueue(async () => {
      if (endpointId === LOCAL_ENDPOINT_ID) {
        throw new Error('the local App endpoint cannot be removed')
      }
      const previous = await this.endpointConfigStore.getForLifecycleMutation()
      const existing = this.requireServer(previous, endpointId)
      this.assertExpected(existing, expected)
      this.assertMutable(existing)
      const wasActive = previous.activeEndpointId === endpointId
      if (wasActive) await this.beforeConnectionChange()
      invalidateEndpointIncarnation(endpointId)
      await this.endpointConfigWriter.set(
        this.withPendingCleanup(
          previous,
          null,
          {
            endpointId,
            canonicalWsBase: existing.url,
            invalidatedRevision: existing.revision,
          },
          wasActive ? LOCAL_ENDPOINT_ID : previous.activeEndpointId
        )
      )
      await this.retireAuthority(
        createRemoteBackendAuthority({
          endpointId,
          wsBase: existing.url,
        })
      )
      await this.endpointConfigWriter.set(
        this.finishCleanup(
          await this.endpointConfigStore.getForLifecycleMutation(),
          endpointId
        )
      )
      const next = await this.endpointConfigStore.getForLifecycleMutation()
      return { config: next, wasActive }
    })
  }

  async recoverPendingCleanup(): Promise<void> {
    return this.enqueue(async () => {
      let config = await this.endpointConfigStore.getForLifecycleMutation()
      for (const tombstone of config.cleanupTombstones) {
        await this.retireAuthority(
          createRemoteBackendAuthority({
            endpointId: tombstone.endpointId,
            wsBase: tombstone.canonicalWsBase,
          })
        )
        config = this.finishCleanup(
          await this.endpointConfigStore.getForLifecycleMutation(),
          tombstone.endpointId
        )
        await this.endpointConfigWriter.set(config)
        config = await this.endpointConfigStore.getForLifecycleMutation()
      }
    })
  }

  private withPendingCleanup(
    config: EndpointConfig,
    nextProfile: MotrixServerEndpoint | null,
    tombstone: EndpointCleanupTombstone,
    activeEndpointId = config.activeEndpointId
  ): EndpointConfig {
    const cleanupTombstones = [
      ...config.cleanupTombstones.filter(
        (candidate) => candidate.endpointId !== tombstone.endpointId
      ),
      tombstone,
    ]
    const servers = config.servers
      .filter(({ id }) => id !== tombstone.endpointId)
      .concat(nextProfile === null ? [] : [nextProfile])
    return {
      version: config.version,
      activeEndpointId,
      servers,
      cleanupTombstones,
    }
  }

  private finishCleanup(
    config: EndpointConfig,
    endpointId: string
  ): EndpointConfig {
    return {
      version: config.version,
      activeEndpointId: config.activeEndpointId,
      servers: config.servers.map((server) =>
        server.id === endpointId && server.state === 'cleanup-pending'
          ? { ...server, state: 'ready' as const }
          : server
      ),
      cleanupTombstones: config.cleanupTombstones.filter(
        (candidate) => candidate.endpointId !== endpointId
      ),
    }
  }

  private requireServer(
    config: EndpointConfig,
    endpointId: string
  ): MotrixServerEndpoint {
    const server = config.servers.find(({ id }) => id === endpointId)
    if (!server) throw new Error(`unknown endpoint: ${endpointId}`)
    return server
  }

  private assertExpected(
    actual: MotrixServerEndpoint,
    expected: Pick<MotrixServerEndpoint, 'name' | 'url' | 'revision'>
  ): void {
    if (
      actual.name !== expected.name.trim() ||
      normalizeRemoteEndpoint(actual.url) !==
        normalizeRemoteEndpoint(expected.url) ||
      actual.revision !== expected.revision
    ) {
      throw new Error('server changed; refresh and try again')
    }
  }

  private assertMutable(server: MotrixServerEndpoint): void {
    if (server.state !== 'ready') {
      throw new EndpointCleanupPendingError()
    }
  }

  private assertEndpointAvailable(
    config: EndpointConfig,
    endpointId: string,
    canonicalUrl: string
  ): void {
    if (
      endpointId !== '' &&
      config.cleanupTombstones.some(
        (candidate) => candidate.endpointId === endpointId
      )
    ) {
      throw new EndpointCleanupPendingError()
    }
    if (
      config.cleanupTombstones.some(
        (candidate) => candidate.canonicalWsBase === canonicalUrl
      )
    ) {
      throw new Error('server URL cleanup is still pending')
    }
  }

  private assertUrlAvailable(
    config: EndpointConfig,
    canonicalUrl: string,
    exceptEndpointId?: string
  ): void {
    const duplicate = config.servers.some(
      (candidate) =>
        candidate.id !== exceptEndpointId &&
        normalizeRemoteEndpoint(candidate.url) === canonicalUrl
    )
    if (duplicate) throw new Error('server URL is already configured')
    this.assertEndpointAvailable(config, exceptEndpointId ?? '', canonicalUrl)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator.run(operation)
  }
}

class IssuedBackendAttemptMutationCapability
  implements BackendAttemptMutationCapability
{
  readonly [backendAttemptMutationCapabilityBrand] = true as const

  constructor(
    private readonly owner: EndpointCatalogService,
    private readonly lease: BackendAttemptLease,
    private readonly guard: (attempt: CurrentBackendAttempt) => void
  ) {
    issuedBackendAttemptMutationCapabilities.add(this)
  }

  run<T>(
    operation: (attempt: CurrentBackendAttempt) => Promise<T>
  ): Promise<T> {
    return this.owner.runWithBackendAttemptLease(
      this.lease,
      async (attempt) => {
        this.guard(attempt)
        const result = await operation(attempt)
        this.guard(attempt)
        return result
      }
    )
  }
}
