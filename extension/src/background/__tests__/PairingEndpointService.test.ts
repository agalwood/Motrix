import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import { ConnectionGate } from '@/background/ConnectionGate'
import { EndpointCatalogService } from '@/background/EndpointCatalogService'
import {
  CorruptEndpointConfigStoreError,
  EndpointConfigStore,
} from '@/background/EndpointConfigStore'
import {
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { getClientInstallationId } from '@/background/mbp1/client-installation-id'
import {
  CredentialStore,
  type Principal,
} from '@/background/mbp1/credential-store'
import { PinStore } from '@/background/mbp1/pin-store'
import { computeVerifiedOrigin } from '@/background/mbp1/verified-origin'
import {
  PairingEndpointService,
  pairingAuthorityForEndpoint,
} from '@/background/PairingEndpointService'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
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

async function principal(): Promise<Principal> {
  return {
    browser: 'chromium',
    verifiedOrigin: computeVerifiedOrigin(),
    clientInstallationId: await getClientInstallationId(),
  }
}

async function pairLocal(
  credentialStore: CredentialStore,
  credentialId = 'local-cred-1'
): Promise<void> {
  const owner = await principal()
  const credentials = credentialStore.forAuthorityForTest(
    LOCAL_BACKEND_AUTHORITY
  )
  await credentials.writeProvisionalUnacked(
    owner,
    { credentialId, mutualKey: 'local-key' },
    null
  )
  await credentials.commitAndActivate(credentialId, owner, null)
}

async function pairRemote(
  credentialStore: CredentialStore,
  endpointId: string,
  wsBase: string,
  credentialId: string,
  instanceId: string
): Promise<void> {
  const owner = await principal()
  const credentials = credentialStore.forAuthorityForTest(
    createRemoteBackendAuthority({ endpointId, wsBase })
  )
  await credentials.writeProvisionalUnacked(
    owner,
    { credentialId, mutualKey: `${credentialId}-key` },
    instanceId
  )
  await credentials.commitAndActivate(credentialId, owner, instanceId)
}

async function setup(): Promise<{
  endpointStore: EndpointConfigStore
  service: PairingEndpointService
  credentialStore: CredentialStore
  pinStore: PinStore
}> {
  const endpointStore = new EndpointConfigStore()
  await endpointStore.setForTest({
    version: 3,
    activeEndpointId: 'local',
    servers: [
      {
        id: 'server-a',
        name: 'Server A',
        url: 'wss://a.example',
        revision: 0,
        state: 'ready',
      },
      {
        id: 'server-b',
        name: 'Server B',
        url: 'wss://b.example',
        revision: 0,
        state: 'ready',
      },
    ],
    cleanupTombstones: [],
  })
  const credentialStore = new CredentialStore()
  const pinStore = new PinStore()
  return {
    endpointStore,
    credentialStore,
    pinStore,
    service: new PairingEndpointService(endpointStore, {
      credentialStore,
      pinStore,
      browser: 'chromium',
    }),
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function raceSetup(): Promise<{
  endpointStore: EndpointConfigStore
  catalog: EndpointCatalogService
  coordinator: BackendOperationCoordinator
  events: string[]
}> {
  const endpointStore = new EndpointConfigStore()
  await endpointStore.setForTest({
    version: 3,
    activeEndpointId: 'server-a',
    servers: [
      {
        id: 'server-a',
        name: 'Server A',
        url: 'wss://a.example',
        revision: 0,
        state: 'ready',
      },
      {
        id: 'server-b',
        name: 'Server B',
        url: 'wss://b.example',
        revision: 0,
        state: 'ready',
      },
    ],
    cleanupTombstones: [],
  })
  const coordinator = new BackendOperationCoordinator()
  const events: string[] = []
  const catalog = new EndpointCatalogService(
    endpointStore,
    {
      retire: (authority) =>
        new CredentialStore().revokeAuthority(authority).then(() => undefined),
    },
    {
      coordinator,
      beforeConnectionChange: () => events.push('catalog-stop-a'),
      afterConnectionChange: () => events.push('catalog-connect-b'),
    }
  )
  return { endpointStore, catalog, coordinator, events }
}

describe('endpoint-safe pairing message operations', () => {
  it('reports the local endpoint as not paired until a credential commits', async () => {
    const { service } = await setup()
    expect(await service.getStatus('local')).toEqual({ paired: false })
  })

  it('reports credentials only within their local or remote authority', async () => {
    const { service, credentialStore } = await setup()
    await pairLocal(credentialStore)
    await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'remote-a',
      'instance-a'
    )
    await pairRemote(
      credentialStore,
      'server-b',
      'wss://b.example',
      'remote-b',
      'instance-b'
    )

    expect(await service.getStatus('local')).toEqual({ paired: true })
    expect(await service.getStatus('server-a')).toEqual({ paired: true })
    expect(await service.getStatus('server-b')).toEqual({ paired: true })
  })

  it('forgets only the explicit authority after the active backend changes', async () => {
    const { endpointStore, service, credentialStore } = await setup()
    await pairLocal(credentialStore)
    await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'remote-a',
      'instance-a'
    )
    await pairRemote(
      credentialStore,
      'server-b',
      'wss://b.example',
      'remote-b',
      'instance-b'
    )
    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'Server A',
          url: 'wss://a.example',
          revision: 0,
          state: 'ready',
        },
        {
          id: 'server-b',
          name: 'Server B',
          url: 'wss://b.example',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })

    expect(await service.unpair('server-b')).toEqual({ active: false })
    expect(await service.getStatus('server-b')).toEqual({ paired: false })
    expect(await service.getStatus('server-a')).toEqual({ paired: true })
    expect(await service.getStatus('local')).toEqual({ paired: true })
  })

  it('unpairing the local endpoint revokes its credential and routing pin', async () => {
    const { service, credentialStore, pinStore } = await setup()
    await pairLocal(credentialStore)
    await pinStore.commit('local-cred-1', { port: 16802, instanceId: 'a' })

    expect(await service.unpair('local')).toEqual({ active: true })
    expect(await service.getStatus('local')).toEqual({ paired: false })
    expect(await pinStore.get('local-cred-1')).toBeNull()
  })

  it('does not preserve a local credential when routing-pin cleanup fails', async () => {
    const { service, credentialStore, pinStore } = await setup()
    await pairLocal(credentialStore)
    pinStore.clear = vi.fn(async () => {
      throw new Error('pin storage unavailable')
    })

    await expect(service.unpair('local')).resolves.toEqual({ active: true })
    expect(await service.getStatus('local')).toEqual({ paired: false })
  })

  it('clears only the active remote authority gate when that Server is unpaired', async () => {
    const { endpointStore, credentialStore, pinStore } = await setup()
    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'Server A',
          url: 'wss://a.example',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'remote-a',
      'instance-a'
    )
    const authority = createRemoteBackendAuthority({
      endpointId: 'server-a',
      wsBase: 'wss://a.example',
    })
    const localGate = ConnectionGate.forAuthority(LOCAL_BACKEND_AUTHORITY)
    const remoteGate = ConnectionGate.forAuthority(authority)
    await localGate.pauseDenied('local operator denial')
    await remoteGate.pauseDenied('remote operator denial')
    const onActiveUnpair = vi.fn(async (activeAuthority) => {
      await ConnectionGate.forAuthority(activeAuthority).clear()
    })
    const service = new PairingEndpointService(
      endpointStore,
      { credentialStore, pinStore, browser: 'chromium' },
      { onActiveUnpair }
    )

    await expect(service.unpair('server-a')).resolves.toEqual({ active: true })
    expect(onActiveUnpair).toHaveBeenCalledExactlyOnceWith(
      authority,
      'server-a'
    )
    expect((await remoteGate.get()).reason).toBeNull()
    expect(await localGate.get()).toMatchObject({
      reason: 'denied',
      lastError: 'local operator denial',
    })
  })

  it('does not revoke against the fail-soft local fallback when endpoint storage is corrupt', async () => {
    const { endpointStore, service, credentialStore } = await setup()
    await pairLocal(credentialStore)
    const stored = await browser.storage.local.get('motrix.endpointConfig')
    const valid = stored['motrix.endpointConfig']
    const corrupt = { version: 3, activeEndpointId: 'local' }
    await browser.storage.local.set({ 'motrix.endpointConfig': corrupt })

    await expect(service.unpair('local')).rejects.toBeInstanceOf(
      CorruptEndpointConfigStoreError
    )
    expect(
      (await browser.storage.local.get('motrix.endpointConfig'))[
        'motrix.endpointConfig'
      ]
    ).toBe(corrupt)

    // Model a repair tool restoring the exact prior document. The credential
    // must still be present because the failed lifecycle mutation never
    // derived authority from the read-only safe fallback.
    await browser.storage.local.set({ 'motrix.endpointConfig': valid })
    expect(await service.getStatus('local')).toEqual({ paired: true })
    expect(await endpointStore.getForLifecycleMutation()).toEqual(valid)
  })

  it('answers pairing status for whichever endpoint is active', async () => {
    const { endpointStore, service, credentialStore } = await setup()
    expect(await service.isActivePaired()).toBe(false)
    await pairLocal(credentialStore)
    expect(await service.isActivePaired()).toBe(true)

    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'Server A',
          url: 'wss://a.example',
          revision: 0,
          state: 'ready',
        },
        {
          id: 'server-b',
          name: 'Server B',
          url: 'wss://b.example',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    expect(await service.isActivePaired()).toBe(false)
    await pairRemote(
      credentialStore,
      'server-a',
      'wss://a.example',
      'remote-a',
      'instance-a'
    )
    expect(await service.isActivePaired()).toBe(true)
  })

  it('rejects unknown endpoint ids and exposes no token import API', async () => {
    const { service } = await setup()

    await expect(service.getStatus('missing')).rejects.toThrow(
      'unknown endpoint: missing'
    )
    expect('setToken' in service).toBe(false)
  })

  it('fails closed before storage when a remote snapshot has no stable id', () => {
    expect(() =>
      pairingAuthorityForEndpoint({
        mode: 'remote',
        endpointId: '',
        remoteUrl: 'wss://a.example',
        revision: 0,
      })
    ).toThrow('remote endpoint is missing its stable id')
    expect(browser.storage.local.get).not.toHaveBeenCalled()
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
  })

  it('serializes an in-flight unpair(A) before activate(B) side effects', async () => {
    const { endpointStore, catalog, coordinator, events } = await raceSetup()
    const revokeStarted = deferred()
    const revokeRelease = deferred()
    const revokeAll = vi.fn(async () => {
      revokeStarted.resolve()
      await revokeRelease.promise
      return []
    })
    const credentialStore = {
      revokePrincipalForAuthority: () => revokeAll(),
    } as unknown as CredentialStore
    const pairing = new PairingEndpointService(
      endpointStore,
      {
        credentialStore,
        pinStore: new PinStore(),
        browser: 'chromium',
      },
      {
        coordinator,
        onActiveUnpair: (_authority, endpointId) => {
          events.push(`unpair-stop-${endpointId}`)
        },
      }
    )

    const unpair = pairing.unpair('server-a')
    await revokeStarted.promise
    const activate = catalog.activate('server-b')
    expect((await endpointStore.get()).activeEndpointId).toBe('server-a')
    revokeRelease.resolve()
    await Promise.all([unpair, activate])

    expect((await endpointStore.get()).activeEndpointId).toBe('server-b')
    expect(events).toEqual([
      'unpair-stop-server-a',
      'catalog-stop-a',
      'catalog-connect-b',
    ])
  })
})

describe('atomic popup pairing snapshot', () => {
  it('reports saved pairing separately from a disconnected transport', async () => {
    const { service, credentialStore } = await setup()
    await pairLocal(credentialStore)
    await expect(
      service.readActiveSnapshot(() => ({ state: 'disconnected' }))
    ).resolves.toMatchObject({
      state: 'disconnected',
      pairing: 'stored',
      endpoint: { activeEndpointId: 'local' },
    })
  })
  it('does not guess unpaired when the credential store is unavailable', async () => {
    const { service, credentialStore } = await setup()
    vi.spyOn(
      credentialStore,
      'hasCommittedCredentialForAuthority'
    ).mockRejectedValue(new Error('unavailable'))
    await expect(
      service.readActiveSnapshot(() => ({ state: 'disconnected' }))
    ).resolves.toMatchObject({ pairing: 'unavailable' })
  })
  it('clears the pairing predicate after an explicit unpair', async () => {
    const { service, credentialStore } = await setup()
    await pairLocal(credentialStore)
    await service.unpair('local')
    await expect(
      service.readActiveSnapshot(() => ({ state: 'disconnected' }))
    ).resolves.toMatchObject({ pairing: 'none' })
  })
})

describe('any paired backend', () => {
  it('requires committed credentials, not configured servers', async () => {
    const { service, credentialStore } = await setup()
    expect(await service.hasPairedBackend()).toBe(false)
    const owner = await principal()
    await credentialStore
      .forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
      .writeProvisionalUnacked(
        owner,
        { credentialId: 'pending', mutualKey: 'key' },
        null
      )
    expect(await service.hasPairedBackend()).toBe(false)
    await pairLocal(credentialStore)
    expect(await service.hasPairedBackend()).toBe(true)
    await service.unpair('local')
    expect(await service.hasPairedBackend()).toBe(false)
  })

  it('counts an inactive paired Server and excludes removed profiles', async () => {
    const { service, credentialStore, endpointStore } = await setup()
    await pairRemote(
      credentialStore,
      'server-b',
      'wss://b.example',
      'remote-cred',
      'instance-b'
    )
    expect(await service.isActivePaired()).toBe(false)
    expect(await service.hasPairedBackend()).toBe(true)
    const config = await endpointStore.get()
    await endpointStore.setForTest({
      ...config,
      servers: config.servers.filter((server) => server.id !== 'server-b'),
    })
    expect(await service.hasPairedBackend()).toBe(false)
  })
})
