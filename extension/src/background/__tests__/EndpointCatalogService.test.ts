import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionGate } from '@/background/ConnectionGate'
import {
  assertBackendAttemptMutationCapability,
  type BackendAttemptMutationCapability,
  EndpointCatalogService,
  InvalidBackendAttemptLeaseError,
  RemoteBackendAttemptRequiredError,
  StaleBackendAttemptLeaseError,
} from '@/background/EndpointCatalogService'
import {
  CorruptEndpointConfigStoreError,
  EndpointConfigStore,
  LOCAL_ENDPOINT_ID,
} from '@/background/EndpointConfigStore'
import {
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import {
  CredentialAuthorityRevokedError,
  CredentialStore,
  type Principal,
} from '@/background/mbp1/credential-store'
import {
  clearRemoteBackendPoliciesForAuthority,
  createRemoteBackendPolicyStoreForTest,
  type RemoteBackendPolicyReplacement,
} from '@/background/RemoteBackendPolicyStore'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const PRINCIPAL: Principal = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://test',
  clientInstallationId: 'test-installation',
}

const REMOTE_POLICY: RemoteBackendPolicyReplacement = {
  remoteDataBoundaryAcceptedAt: 1_788_192_000_000,
  allowRequestCredentials: false,
  allowCustomHeaders: false,
  allowPageContent: true,
  allowServerUrlProbe: false,
  allowServerUrlResolve: false,
  allowAutomaticTakeover: false,
}

function server(
  id: string,
  name: string,
  url: string,
  over: Partial<{
    revision: number
    state: 'ready' | 'cleanup-pending'
  }> = {}
) {
  return {
    id,
    name,
    url,
    revision: over.revision ?? 0,
    state: over.state ?? 'ready',
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    if (typeof k === 'string') return k in backing ? { [k]: backing[k] } : {}
    const result: Record<string, unknown> = {}
    for (const key of k) if (key in backing) result[key] = backing[key]
    return result
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

function remoteAuthority(endpointId: string, wsBase: string) {
  return createRemoteBackendAuthority({ endpointId, wsBase })
}

function retirementFor(store: CredentialStore) {
  return {
    retire: (authority: ReturnType<typeof remoteAuthority>) =>
      store.revokeAuthority(authority).then(() => undefined),
  }
}

async function pairLocal(
  store: CredentialStore,
  credentialId = 'local-credential'
): Promise<void> {
  const view = store.forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
  await view.writeProvisionalUnacked(
    PRINCIPAL,
    { credentialId, mutualKey: `${credentialId}-key` },
    null
  )
  await view.commitAndActivate(credentialId, PRINCIPAL, null)
}

async function pairRemote(
  store: CredentialStore,
  endpointId: string,
  wsBase: string,
  credentialId: string,
  instanceId: string
) {
  const view = store.forAuthorityForTest(remoteAuthority(endpointId, wsBase))
  await view.writeProvisionalUnacked(
    PRINCIPAL,
    { credentialId, mutualKey: `${credentialId}-key` },
    instanceId
  )
  await view.commitAndActivate(credentialId, PRINCIPAL, instanceId)
  return view
}

async function paired(
  store: CredentialStore,
  endpointId: string,
  wsBase: string
): Promise<boolean> {
  return store
    .forAuthorityForTest(remoteAuthority(endpointId, wsBase))
    .hasCommittedCredential(PRINCIPAL)
}

async function setup(): Promise<{
  configStore: EndpointConfigStore
  credentialStore: CredentialStore
  service: EndpointCatalogService
}> {
  const configStore = new EndpointConfigStore()
  const credentialStore = new CredentialStore()
  await configStore.setForTest({
    version: 3,
    activeEndpointId: 'local',
    servers: [
      server('server-a', 'A', 'wss://a.example'),
      server('server-b', 'B', 'wss://b.example'),
    ],
    cleanupTombstones: [],
  })
  return {
    configStore,
    credentialStore,
    service: new EndpointCatalogService(
      configStore,
      retirementFor(credentialStore),
      { createId: () => 'server-c' }
    ),
  }
}

describe('EndpointCatalogService', () => {
  it('keeps local, Server A, and Server B isolated through switch, offline, revoke, URL edit, and delete', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: LOCAL_ENDPOINT_ID,
      servers: [
        server('server-a', 'A', 'wss://a.example'),
        server('server-b', 'B', 'wss://b.example'),
      ],
      cleanupTombstones: [],
    })
    const credentials = new CredentialStore()
    const authorityA = remoteAuthority('server-a', 'wss://a.example')
    const authorityB = remoteAuthority('server-b', 'wss://b.example')
    const gateA = ConnectionGate.forAuthority(authorityA)
    const gateB = ConnectionGate.forAuthority(authorityB)
    const policyA = createRemoteBackendPolicyStoreForTest(
      authorityA,
      'instance-a'
    )
    const policyB = createRemoteBackendPolicyStoreForTest(
      authorityB,
      'instance-b'
    )
    await pairLocal(credentials, 'shared-id')
    await pairRemote(
      credentials,
      'server-a',
      'wss://a.example',
      'shared-id',
      'instance-a'
    )
    await pairRemote(
      credentials,
      'server-b',
      'wss://b.example',
      'shared-id',
      'instance-b'
    )
    await policyA.replace(REMOTE_POLICY)
    await policyB.replace({ ...REMOTE_POLICY, allowPageContent: false })
    await gateA.pauseDenied('server A offline')
    await gateB.pausePending(60_000)

    const service = new EndpointCatalogService(configStore, {
      retire: async (authority) => {
        await credentials.revokeAuthority(authority)
        await ConnectionGate.forAuthority(authority).clear()
        await clearRemoteBackendPoliciesForAuthority(authority)
      },
    })

    await service.activate('server-a')
    await service.activate('server-b')
    await service.activate(LOCAL_ENDPOINT_ID)
    expect((await configStore.get()).activeEndpointId).toBe(LOCAL_ENDPOINT_ID)
    expect((await gateA.get()).lastError).toBe('server A offline')
    expect((await gateB.get()).reason).toBe('pair-pending')
    expect(await credentials.hasCommittedCredential(PRINCIPAL)).toBe(true)

    await credentials.revokePrincipalForAuthority(authorityA, PRINCIPAL)
    expect(await paired(credentials, 'server-a', 'wss://a.example')).toBe(false)
    expect(await paired(credentials, 'server-b', 'wss://b.example')).toBe(true)
    expect(await credentials.hasCommittedCredential(PRINCIPAL)).toBe(true)
    expect((await policyB.get()).remoteDataBoundaryAcceptedAt).toBe(
      REMOTE_POLICY.remoteDataBoundaryAcceptedAt
    )

    await pairRemote(
      credentials,
      'server-a',
      'wss://a.example',
      'a-repaired',
      'instance-a'
    )
    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A', url: 'wss://new-a.example' }
    )
    const authorityNewA = remoteAuthority('server-a', 'wss://new-a.example')
    expect(await paired(credentials, 'server-a', 'wss://a.example')).toBe(false)
    expect((await gateA.get()).reason).toBeNull()
    expect((await policyA.get()).remoteDataBoundaryAcceptedAt).toBeNull()
    expect(await paired(credentials, 'server-b', 'wss://b.example')).toBe(true)
    expect(await credentials.hasCommittedCredential(PRINCIPAL)).toBe(true)

    await pairRemote(
      credentials,
      'server-a',
      'wss://new-a.example',
      'new-a',
      'instance-new-a'
    )
    const policyNewA = createRemoteBackendPolicyStoreForTest(
      authorityNewA,
      'instance-new-a'
    )
    await policyNewA.replace(REMOTE_POLICY)
    await service.activate('server-b')
    await service.removeServer('server-b', {
      name: 'B',
      url: 'wss://b.example',
      revision: 0,
    })

    expect((await configStore.get()).activeEndpointId).toBe(LOCAL_ENDPOINT_ID)
    expect(await paired(credentials, 'server-b', 'wss://b.example')).toBe(false)
    expect((await gateB.get()).reason).toBeNull()
    expect((await policyB.get()).remoteDataBoundaryAcceptedAt).toBeNull()
    expect(await paired(credentials, 'server-a', 'wss://new-a.example')).toBe(
      true
    )
    expect((await policyNewA.get()).allowPageContent).toBe(true)
    expect(await credentials.hasCommittedCredential(PRINCIPAL)).toBe(true)
  })

  it('serializes add and activate intents without losing either update', async () => {
    const { configStore, service } = await setup()

    await Promise.all([
      service.addServer({ name: 'C', url: 'wss://c.example' }),
      service.activate('server-a'),
    ])

    const config = await configStore.get()
    expect(config.activeEndpointId).toBe('server-a')
    expect(config.servers.map(({ id }) => id)).toEqual([
      'server-a',
      'server-b',
      'server-c',
    ])
  })

  it('retires only the old authority when an active Server URL changes', async () => {
    const { credentialStore, service } = await setup()
    await service.activate('server-a')
    await pairLocal(credentialStore)
    const staleA = await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'credential-a',
      'instance-a'
    )
    await pairRemote(
      credentialStore,
      'server-b',
      'wss://b.example',
      'credential-b',
      'instance-b'
    )

    const result = await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A updated', url: 'wss://new-a.example/proxy/' }
    )

    expect(result).toMatchObject({ active: true, urlChanged: true })
    expect(result.config.servers.find(({ id }) => id === 'server-a')).toEqual({
      id: 'server-a',
      name: 'A updated',
      url: 'wss://new-a.example/proxy',
      revision: 1,
      state: 'ready',
    })
    expect(await paired(credentialStore, 'server-a', 'wss://a.example')).toBe(
      false
    )
    expect(
      await paired(credentialStore, 'server-a', 'wss://new-a.example/proxy')
    ).toBe(false)
    expect(await paired(credentialStore, 'server-b', 'wss://b.example')).toBe(
      true
    )
    expect(
      await credentialStore
        .forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
        .hasCommittedCredential(PRINCIPAL)
    ).toBe(true)
    await expect(
      staleA.writeProvisionalUnacked(
        PRINCIPAL,
        { credentialId: 'revived', mutualKey: 'revived-key' },
        'instance-a'
      )
    ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)
  })

  it('removes an active Server, falls back local, and retires its authority', async () => {
    const { credentialStore, service } = await setup()
    await service.activate('server-a')
    await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'credential-a',
      'instance-a'
    )
    await pairRemote(
      credentialStore,
      'server-b',
      'wss://b.example',
      'credential-b',
      'instance-b'
    )

    const result = await service.removeServer('server-a', {
      name: 'A',
      url: 'wss://a.example',
      revision: 0,
    })

    expect(result.wasActive).toBe(true)
    expect(result.config.activeEndpointId).toBe('local')
    expect(result.config.servers.map(({ id }) => id)).toEqual(['server-b'])
    expect(await paired(credentialStore, 'server-a', 'wss://a.example')).toBe(
      false
    )
    expect(await paired(credentialStore, 'server-b', 'wss://b.example')).toBe(
      true
    )
  })

  it('stops before removing the active Server without reconnecting or allowing App launch', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://a.example'),
        server('server-b', 'B', 'wss://b.example'),
      ],
      cleanupTombstones: [],
    })
    const events: string[] = []
    const service = new EndpointCatalogService(
      configStore,
      retirementFor(new CredentialStore()),
      {
        beforeConnectionChange: () => events.push('stop'),
        afterConnectionChange: () =>
          events.push('clearGateAndStart(allowLaunch:true)'),
      }
    )

    const result = await service.removeServer('server-a', {
      name: 'A',
      url: 'wss://a.example',
      revision: 0,
    })

    expect(result.wasActive).toBe(true)
    expect(result.config.activeEndpointId).toBe('local')
    expect(events).toEqual(['stop'])
  })

  it('removes a non-active Server without stopping or reconnecting', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://a.example'),
        server('server-b', 'B', 'wss://b.example'),
      ],
      cleanupTombstones: [],
    })
    const events: string[] = []
    const service = new EndpointCatalogService(
      configStore,
      retirementFor(new CredentialStore()),
      {
        beforeConnectionChange: () => events.push('stop'),
        afterConnectionChange: () => events.push('reconnect'),
      }
    )

    const result = await service.removeServer('server-b', {
      name: 'B',
      url: 'wss://b.example',
      revision: 0,
    })

    expect(result.wasActive).toBe(false)
    expect(result.config.activeEndpointId).toBe('server-a')
    expect(events).toEqual([])
  })

  it('does not expose a bulk replacement API that can erase tombstones', async () => {
    const { service } = await setup()
    expect('replace' in service).toBe(false)
  })

  it('issues nominal leases only for local or ready remote profiles', async () => {
    const { configStore, service } = await setup()
    const localLease = await service.issueBackendAttemptLease('local')
    await expect(
      service.runWithBackendAttemptLease(localLease, async (attempt) => attempt)
    ).resolves.toMatchObject({
      endpointId: 'local',
      canonicalWsBase: null,
      revision: 0,
      authority: { kind: 'local' },
    })
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [
        server('server-a', 'A', 'wss://new-a.example', {
          revision: 1,
          state: 'cleanup-pending',
        }),
      ],
      cleanupTombstones: [
        {
          endpointId: 'server-a',
          canonicalWsBase: 'wss://a.example',
          invalidatedRevision: 0,
        },
      ],
    })

    await expect(
      service.issueBackendAttemptLease('server-a')
    ).rejects.toBeInstanceOf(RemoteBackendAttemptRequiredError)
  })

  it('rejects forged and copied leases before invoking a mutation', async () => {
    const { service } = await setup()
    const issued = await service.issueBackendAttemptLease('server-a')
    const operation = vi.fn(async () => undefined)

    await expect(
      service.runWithBackendAttemptLease(
        { kind: 'remote-backend-attempt-lease' },
        operation
      )
    ).rejects.toBeInstanceOf(InvalidBackendAttemptLeaseError)
    await expect(
      service.runWithBackendAttemptLease({ ...issued }, operation)
    ).rejects.toBeInstanceOf(InvalidBackendAttemptLeaseError)
    expect(() =>
      service.bindBackendAttemptLease({
        kind: 'remote-backend-attempt-lease',
      })
    ).toThrow(InvalidBackendAttemptLeaseError)
    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects structural run objects as durable mutation capabilities', () => {
    const forged = {
      run: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    } as unknown as BackendAttemptMutationCapability

    expect(() => assertBackendAttemptMutationCapability(forged)).toThrow(
      'was not issued'
    )
  })

  it('keeps a lease valid across display-name edits but not URL changes', async () => {
    const { service } = await setup()
    const lease = await service.issueBackendAttemptLease('server-a')

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'Renamed', url: 'wss://a.example' }
    )
    await expect(
      service.runWithBackendAttemptLease(lease, async (attempt) => attempt)
    ).resolves.toMatchObject({
      endpointId: 'server-a',
      canonicalWsBase: 'wss://a.example',
      revision: 0,
    })

    await service.updateServer(
      'server-a',
      { name: 'Renamed', url: 'wss://a.example', revision: 0 },
      { name: 'Renamed', url: 'wss://new-a.example' }
    )
    await expect(
      service.runWithBackendAttemptLease(lease, async () => undefined)
    ).rejects.toBeInstanceOf(StaleBackendAttemptLeaseError)
  })

  it('prevents a lease-bound credential writer from reviving a retired authority', async () => {
    const { credentialStore, service } = await setup()
    const authority = remoteAuthority('server-a', 'wss://a.example')
    const lease = await service.issueBackendAttemptLease('server-a')
    const lifecycle = credentialStore.forAttempt(
      authority,
      service.bindBackendAttemptLease(lease)
    )
    await lifecycle.writeProvisionalUnacked(
      PRINCIPAL,
      { credentialId: 'old-offer', mutualKey: 'old-key' },
      'instance-a'
    )

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A', url: 'wss://new-a.example' }
    )

    await expect(
      lifecycle.writeProvisionalUnacked(
        PRINCIPAL,
        { credentialId: 'late-offer', mutualKey: 'late-key' },
        'instance-a'
      )
    ).rejects.toBeInstanceOf(StaleBackendAttemptLeaseError)
    expect(
      await credentialStore
        .forAuthorityForTest(authority)
        .recoverOrder(PRINCIPAL)
    ).toEqual([])
  })

  it('serializes a bounded leased write ahead of authority retirement', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [server('server-a', 'A', 'wss://a.example')],
      cleanupTombstones: [],
    })
    const events: string[] = []
    let release = (): void => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new EndpointCatalogService(configStore, {
      retire: async () => {
        events.push('retire')
      },
    })
    const lease = await service.issueBackendAttemptLease('server-a')
    const write = service.runWithBackendAttemptLease(lease, async () => {
      events.push('write-start')
      await blocked
      events.push('write-done')
    })
    await vi.waitFor(() => expect(events).toEqual(['write-start']))
    const edit = service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A', url: 'wss://new-a.example' }
    )

    expect(events).toEqual(['write-start'])
    release()
    await Promise.all([write, edit])
    expect(events).toEqual(['write-start', 'write-done', 'retire'])
  })

  it('blocks every lifecycle operation while preserving a corrupt catalogue', async () => {
    const corrupt = {
      version: 3,
      activeEndpointId: 'local',
      servers: [],
      cleanupTombstones: [
        {
          endpointId: 'server-a',
          canonicalWsBase: 'wss://a.example',
        },
      ],
    }
    await browser.storage.local.set({ 'motrix.endpointConfig': corrupt })
    vi.mocked(browser.storage.local.set).mockClear()
    const retire = vi.fn(async () => undefined)
    const service = new EndpointCatalogService(
      new EndpointConfigStore(),
      { retire },
      { createId: () => 'server-c' }
    )
    const operations = [
      () => service.activate('server-a'),
      () => service.addServer({ name: 'C', url: 'wss://c.example' }),
      () =>
        service.updateServer(
          'server-a',
          { name: 'A', url: 'wss://a.example', revision: 0 },
          { name: 'Changed', url: 'wss://changed.example' }
        ),
      () =>
        service.removeServer('server-a', {
          name: 'A',
          url: 'wss://a.example',
          revision: 0,
        }),
      () => service.recoverPendingCleanup(),
    ]

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(
        CorruptEndpointConfigStoreError
      )
    }
    const stored = await browser.storage.local.get('motrix.endpointConfig')
    expect(stored['motrix.endpointConfig']).toBe(corrupt)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps cleanup pending state when durable authority retirement fails', async () => {
    const { configStore } = await setup()
    const retireAuthority = vi.fn(async () => {
      throw new Error('credential storage unavailable')
    })
    const service = new EndpointCatalogService(configStore, {
      retire: retireAuthority,
    })

    await expect(
      service.updateServer(
        'server-a',
        { name: 'A', url: 'wss://a.example', revision: 0 },
        { name: 'A changed', url: 'wss://new-a.example' }
      )
    ).rejects.toThrow('credential storage unavailable')

    expect(
      (await configStore.get()).servers.find(({ id }) => id === 'server-a')
    ).toEqual({
      id: 'server-a',
      name: 'A changed',
      url: 'wss://new-a.example',
      revision: 1,
      state: 'cleanup-pending',
    })
    expect((await configStore.get()).cleanupTombstones).toEqual([
      {
        endpointId: 'server-a',
        canonicalWsBase: 'wss://a.example',
        invalidatedRevision: 0,
      },
    ])
    expect(retireAuthority).toHaveBeenCalledTimes(1)
  })

  it('persists the tombstone before retiring an active URL change and finalizes after', async () => {
    const { configStore } = await setup()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://a.example'),
        server('server-b', 'B', 'wss://b.example'),
      ],
      cleanupTombstones: [],
    })
    const events: string[] = []
    const originalSet = browser.storage.local.set
    browser.storage.local.set = vi.fn(async (items) => {
      events.push('set')
      await originalSet(items)
    })
    const service = new EndpointCatalogService(
      configStore,
      {
        retire: async () => {
          events.push('retire')
        },
      },
      {
        beforeConnectionChange: () => events.push('stop'),
        afterConnectionChange: () => events.push('connect'),
      }
    )

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A changed', url: 'wss://new-a.example' }
    )

    expect(events).toEqual(['stop', 'set', 'retire', 'set', 'connect'])
  })

  it('does not retire an authority for a display-name-only edit', async () => {
    const { configStore } = await setup()
    const retireAuthority = vi.fn(async () => undefined)
    const service = new EndpointCatalogService(configStore, {
      retire: retireAuthority,
    })

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'Renamed', url: 'wss://a.example/' }
    )

    expect(retireAuthority).not.toHaveBeenCalled()
    expect(
      (await configStore.get()).servers.find(({ id }) => id === 'server-a')
        ?.revision
    ).toBe(0)
  })

  it('rejects unknown selection, local removal, and duplicate URLs', async () => {
    const { service } = await setup()

    await expect(service.activate('missing')).rejects.toThrow(
      'unknown endpoint: missing'
    )
    await expect(
      service.removeServer('local', {
        name: 'Motrix App',
        url: '',
        revision: 0,
      })
    ).rejects.toThrow('local App endpoint cannot be removed')
    await expect(
      service.addServer({ name: 'Duplicate', url: 'wss://A.example:443/' })
    ).rejects.toThrow('server URL is already configured')
  })

  it.each([
    ['leading whitespace', ' wss://motrix.example'],
    ['layered encoded slash', 'wss://motrix.example/%252fadmin'],
  ])(
    'does not sanitize %s before the strict storage boundary',
    async (_label, url) => {
      const { configStore, service } = await setup()

      await expect(service.addServer({ name: 'Unsafe', url })).rejects.toThrow()
      expect((await configStore.get()).servers.map(({ id }) => id)).toEqual([
        'server-a',
        'server-b',
      ])
    }
  )

  it('rejects stale edit and delete snapshots instead of overwriting newer data', async () => {
    const { service } = await setup()

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'Renamed elsewhere', url: 'wss://a.example' }
    )

    await expect(
      service.updateServer(
        'server-a',
        { name: 'A', url: 'wss://a.example', revision: 0 },
        { name: 'Stale edit', url: 'wss://new.example' }
      )
    ).rejects.toThrow('server changed; refresh and try again')
    await expect(
      service.removeServer('server-a', {
        name: 'A',
        url: 'wss://a.example',
        revision: 0,
      })
    ).rejects.toThrow('server changed; refresh and try again')
  })

  it('rejects ABA edit and delete snapshots by endpoint revision', async () => {
    const { service } = await setup()
    const lease = await service.issueBackendAttemptLease('server-a')

    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://a.example', revision: 0 },
      { name: 'A', url: 'wss://bounced.example' }
    )
    await service.updateServer(
      'server-a',
      { name: 'A', url: 'wss://bounced.example', revision: 1 },
      { name: 'A', url: 'wss://a.example' }
    )

    await expect(
      service.updateServer(
        'server-a',
        { name: 'A', url: 'wss://a.example', revision: 0 },
        { name: 'stale', url: 'wss://stale.example' }
      )
    ).rejects.toThrow('server changed; refresh and try again')
    await expect(
      service.removeServer('server-a', {
        name: 'A',
        url: 'wss://a.example',
        revision: 0,
      })
    ).rejects.toThrow('server changed; refresh and try again')
    await expect(
      service.runWithBackendAttemptLease(lease, async () => undefined)
    ).rejects.toBeInstanceOf(StaleBackendAttemptLeaseError)
  })

  it('rejects an old lease after delete and same-id same-URL re-add', async () => {
    const { configStore } = await setup()
    const service = new EndpointCatalogService(
      configStore,
      { retire: async () => undefined },
      { createId: () => 'server-a' }
    )
    const lease = await service.issueBackendAttemptLease('server-a')

    await service.removeServer('server-a', {
      name: 'A',
      url: 'wss://a.example',
      revision: 0,
    })
    await service.addServer({ name: 'A again', url: 'wss://a.example' })

    expect(
      (await configStore.get()).servers.find(({ id }) => id === 'server-a')
    ).toMatchObject({
      id: 'server-a',
      url: 'wss://a.example',
      revision: 0,
      state: 'ready',
    })
    await expect(
      service.runWithBackendAttemptLease(lease, async () => undefined)
    ).rejects.toBeInstanceOf(StaleBackendAttemptLeaseError)
  })

  it('recovers an interrupted URL change before making the profile ready', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://new-a.example', {
          revision: 1,
          state: 'cleanup-pending',
        }),
      ],
      cleanupTombstones: [
        {
          endpointId: 'server-a',
          canonicalWsBase: 'wss://a.example',
          invalidatedRevision: 0,
        },
      ],
    })
    const retire = vi.fn(async () => undefined)
    const service = new EndpointCatalogService(configStore, { retire })

    await service.recoverPendingCleanup()

    expect(retire).toHaveBeenCalledWith(
      remoteAuthority('server-a', 'wss://a.example')
    )
    expect(await configStore.get()).toEqual({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://new-a.example', {
          revision: 1,
          state: 'ready',
        }),
      ],
      cleanupTombstones: [],
    })
  })

  it('leaves an interrupted cleanup closed when retirement still fails', async () => {
    const configStore = new EndpointConfigStore()
    const pending = {
      version: 3 as const,
      activeEndpointId: 'local',
      servers: [],
      cleanupTombstones: [
        {
          endpointId: 'server-a',
          canonicalWsBase: 'wss://a.example',
          invalidatedRevision: 0,
        },
      ],
    }
    await configStore.setForTest(pending)
    const service = new EndpointCatalogService(configStore, {
      retire: async () => {
        throw new Error('retirement unavailable')
      },
    })

    await expect(service.recoverPendingCleanup()).rejects.toThrow(
      'retirement unavailable'
    )
    expect(await configStore.get()).toEqual(pending)
  })

  it('rejects revision overflow before stopping or writing an active profile', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        server('server-a', 'A', 'wss://a.example', {
          revision: Number.MAX_SAFE_INTEGER,
        }),
      ],
      cleanupTombstones: [],
    })
    vi.mocked(browser.storage.local.set).mockClear()
    const stop = vi.fn()
    const retire = vi.fn(async () => undefined)
    const service = new EndpointCatalogService(
      configStore,
      { retire },
      { beforeConnectionChange: stop }
    )

    await expect(
      service.updateServer(
        'server-a',
        {
          name: 'A',
          url: 'wss://a.example',
          revision: Number.MAX_SAFE_INTEGER,
        },
        { name: 'A', url: 'wss://new-a.example' }
      )
    ).rejects.toThrow('server revision is exhausted')
    expect(stop).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('allows deleting a profile at the maximum revision', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [
        server('server-a', 'A', 'wss://a.example', {
          revision: Number.MAX_SAFE_INTEGER,
        }),
      ],
      cleanupTombstones: [],
    })
    const service = new EndpointCatalogService(configStore, {
      retire: async () => undefined,
    })

    await service.removeServer('server-a', {
      name: 'A',
      url: 'wss://a.example',
      revision: Number.MAX_SAFE_INTEGER,
    })

    expect((await configStore.get()).servers).toEqual([])
    expect((await configStore.get()).cleanupTombstones).toEqual([])
  })

  it('stops the old connection before committing an active change', async () => {
    const configStore = new EndpointConfigStore()
    await configStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server('server-a', 'A', 'wss://a.example')],
      cleanupTombstones: [],
    })
    const events: string[] = []
    const originalSet = browser.storage.local.set
    browser.storage.local.set = vi.fn(async (items) => {
      events.push('set')
      await originalSet(items)
    })
    const service = new EndpointCatalogService(
      configStore,
      retirementFor(new CredentialStore()),
      {
        beforeConnectionChange: () => {
          events.push('stop')
        },
      }
    )

    await service.activate('server-a')

    expect(events).toEqual(['stop', 'set'])
  })
})
