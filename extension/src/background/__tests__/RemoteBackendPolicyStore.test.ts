import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EndpointCatalogService } from '@/background/EndpointCatalogService'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import {
  backendAuthorityKey,
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'
import {
  CorruptRemoteBackendPolicyStoreError,
  clearRemoteBackendPoliciesForAuthority,
  createLeaseBoundRemoteBackendPolicyStore,
  createRemoteBackendPolicyStoreForTest,
  InvalidAuthenticatedInstanceIdError,
  InvalidRemoteBackendPolicyError,
  REMOTE_BACKEND_POLICY_VERSION,
  type RemoteBackendPolicyReplacement,
  RemoteBackendPolicyRequiresRemoteAuthorityError,
  type RemoteBackendPolicyTestStore,
  RemoteDataBoundaryRequiredError,
  UnsupportedRemoteBackendPolicyVersionError,
} from '@/background/RemoteBackendPolicyStore'

declare const browser: {
  storage: {
    local: {
      get: (key: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (key: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.remoteBackendPolicies'

const SERVER_A = createRemoteBackendAuthority({
  endpointId: 'server-a',
  wsBase: 'wss://a.example/bridge',
})

const SERVER_B = createRemoteBackendAuthority({
  endpointId: 'server-b',
  wsBase: 'wss://b.example/bridge',
})

const ALL_OFF: RemoteBackendPolicyReplacement = {
  remoteDataBoundaryAcceptedAt: null,
  allowRequestCredentials: false,
  allowCustomHeaders: false,
  allowPageContent: false,
  allowServerUrlProbe: false,
  allowServerUrlResolve: false,
  allowAutomaticTakeover: false,
}

const GRANTED: RemoteBackendPolicyReplacement = {
  remoteDataBoundaryAcceptedAt: 1_787_990_400_000,
  allowRequestCredentials: true,
  allowCustomHeaders: true,
  allowPageContent: true,
  allowServerUrlProbe: true,
  allowServerUrlResolve: true,
  allowAutomaticTakeover: true,
}

let backing: Record<string, unknown>

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (key: string | string[]) => {
    const resolved = Array.isArray(key) ? key[0] : key
    return resolved !== undefined && Object.hasOwn(backing, resolved)
      ? { [resolved]: backing[resolved] }
      : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (key: string | string[]) => {
    for (const resolved of Array.isArray(key) ? key : [key]) {
      delete backing[resolved]
    }
  })
})

function store(
  authority: RemoteBackendAuthority = SERVER_A,
  instanceId = 'instance-a'
): RemoteBackendPolicyTestStore {
  return createRemoteBackendPolicyStoreForTest(authority, instanceId)
}

function defaultPolicy(
  authority: RemoteBackendAuthority = SERVER_A,
  instanceId = 'instance-a'
) {
  return {
    version: REMOTE_BACKEND_POLICY_VERSION,
    authorityKey: backendAuthorityKey(authority),
    authenticatedInstanceId: instanceId,
    ...ALL_OFF,
  }
}

function persistedPolicy(
  authority: RemoteBackendAuthority,
  instanceId: string,
  replacement: RemoteBackendPolicyReplacement = GRANTED
) {
  return {
    version: REMOTE_BACKEND_POLICY_VERSION,
    authorityKey: backendAuthorityKey(authority),
    authenticatedInstanceId: instanceId,
    ...replacement,
  }
}

function storedPolicies(): unknown[] {
  return (backing[STORAGE_KEY] as { version: number; policies: unknown[] })
    .policies
}

describe('RemoteBackendPolicyStore authority and identity boundary', () => {
  it('defaults every permission off without creating storage', async () => {
    expect(await store().get()).toEqual(defaultPolicy())
    expect(backing).toEqual({})
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('round-trips one complete policy bound to authority and instance', async () => {
    const policyStore = store()
    await policyStore.replace(GRANTED)

    expect(await policyStore.get()).toEqual({
      version: 1,
      authorityKey: backendAuthorityKey(SERVER_A),
      authenticatedInstanceId: 'instance-a',
      ...GRANTED,
    })
    expect(storedPolicies()).toHaveLength(1)
  })

  it('keeps Server A and Server B policies independent', async () => {
    const a = store(SERVER_A, 'instance-a')
    const b = store(SERVER_B, 'instance-b')
    await a.replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 100,
      allowServerUrlProbe: true,
    })
    await b.replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 200,
      allowPageContent: true,
    })

    expect((await a.get()).allowServerUrlProbe).toBe(true)
    expect((await a.get()).allowPageContent).toBe(false)
    expect((await b.get()).allowServerUrlProbe).toBe(false)
    expect((await b.get()).allowPageContent).toBe(true)
    expect(storedPolicies()).toHaveLength(2)
  })

  it('treats a URL change as a new all-disabled authority', async () => {
    const oldAuthority = createRemoteBackendAuthority({
      endpointId: 'same-endpoint',
      wsBase: 'wss://old.example/bridge',
    })
    const newAuthority = createRemoteBackendAuthority({
      endpointId: 'same-endpoint',
      wsBase: 'wss://new.example/bridge',
    })
    await store(oldAuthority, 'same-instance').replace(GRANTED)

    expect(await store(newAuthority, 'same-instance').get()).toEqual(
      defaultPolicy(newAuthority, 'same-instance')
    )
    expect(await store(oldAuthority, 'same-instance').get()).toEqual({
      ...defaultPolicy(oldAuthority, 'same-instance'),
      ...GRANTED,
    })
  })

  it('treats an authenticated instance change as all-disabled', async () => {
    await store(SERVER_A, 'old-instance').replace(GRANTED)

    expect(await store(SERVER_A, 'new-instance').get()).toEqual(
      defaultPolicy(SERVER_A, 'new-instance')
    )
  })

  it('a full replacement for a new instance removes the old identity grants', async () => {
    const oldIdentity = store(SERVER_A, 'old-instance')
    const newIdentity = store(SERVER_A, 'new-instance')
    await oldIdentity.replace(GRANTED)
    await newIdentity.replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 300,
      allowServerUrlResolve: true,
    })

    expect(await oldIdentity.get()).toEqual(
      defaultPolicy(SERVER_A, 'old-instance')
    )
    expect((await newIdentity.get()).allowServerUrlResolve).toBe(true)
    expect(storedPolicies()).toHaveLength(1)
  })

  it('a second full replacement resets every omitted prior grant', async () => {
    const policyStore = store()
    await policyStore.replace(GRANTED)
    await policyStore.replace(ALL_OFF)

    expect(await policyStore.get()).toEqual(defaultPolicy())
    expect(storedPolicies()).toEqual([
      persistedPolicy(SERVER_A, 'instance-a', ALL_OFF),
    ])
  })

  it('rejects local and structurally forged authorities', () => {
    expect(() =>
      createRemoteBackendPolicyStoreForTest(
        LOCAL_BACKEND_AUTHORITY as unknown as RemoteBackendAuthority,
        'instance'
      )
    ).toThrow(RemoteBackendPolicyRequiresRemoteAuthorityError)

    const forged = {
      kind: 'remote',
      endpointId: 'server-a',
      canonicalWsBase: 'wss://a.example/bridge',
    } as unknown as RemoteBackendAuthority
    expect(() =>
      createRemoteBackendPolicyStoreForTest(forged, 'instance')
    ).toThrow('BackendAuthority must be created by its module factory')
  })
})

describe('RemoteBackendPolicyStore validation', () => {
  it.each([
    ['', 'empty'],
    ['line\nbreak', 'control'],
    ['delete\u007f', 'delete'],
    ['实例', 'non-ASCII'],
    ['x'.repeat(129), 'oversized'],
  ])('rejects a %s instance id using a fixed error', (instanceId) => {
    let error: unknown
    try {
      store(SERVER_A, instanceId)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(InvalidAuthenticatedInstanceIdError)
    expect((error as Error).message).toBe(
      'authenticated instance id is outside the accepted printable form'
    )
  })

  it('accepts the printable ASCII length boundary exactly', async () => {
    const instanceId = '~'.repeat(128)
    expect(
      (await store(SERVER_A, instanceId).get()).authenticatedInstanceId
    ).toBe(instanceId)
  })

  it.each([
    'allowRequestCredentials',
    'allowCustomHeaders',
    'allowPageContent',
    'allowServerUrlProbe',
    'allowServerUrlResolve',
    'allowAutomaticTakeover',
  ] as const)(
    'rejects sensitive grant %s before accepting the data boundary',
    async (permission) => {
      await expect(
        store().replace({ ...ALL_OFF, [permission]: true })
      ).rejects.toBeInstanceOf(RemoteDataBoundaryRequiredError)
      expect(backing).toEqual({})
    }
  )

  it.each([
    ['string', '123'],
    ['boolean', true],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a non-timestamp %s exactly', async (_label, timestamp) => {
    await expect(
      store().replace({
        ...ALL_OFF,
        remoteDataBoundaryAcceptedAt: timestamp as number,
      })
    ).rejects.toBeInstanceOf(InvalidRemoteBackendPolicyError)
  })

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'accepts safe non-negative integer timestamp %s',
    async (timestamp) => {
      const policyStore = store()
      await policyStore.replace({
        ...ALL_OFF,
        remoteDataBoundaryAcceptedAt: timestamp,
        allowPageContent: true,
      })
      expect((await policyStore.get()).remoteDataBoundaryAcceptedAt).toBe(
        timestamp
      )
    }
  )

  it.each([
    ['numeric', 1],
    ['string', 'true'],
    ['null', null],
    ['boxed', new Boolean(true)],
  ])('rejects a non-boolean permission value: %s', async (_label, value) => {
    await expect(
      store().replace({
        ...ALL_OFF,
        remoteDataBoundaryAcceptedAt: 1,
        allowCustomHeaders: value,
      } as unknown as RemoteBackendPolicyReplacement)
    ).rejects.toBeInstanceOf(InvalidRemoteBackendPolicyError)
  })

  it('rejects missing and extra fields instead of patching or persisting them', async () => {
    await expect(
      store().replace({
        remoteDataBoundaryAcceptedAt: 1,
      } as RemoteBackendPolicyReplacement)
    ).rejects.toBeInstanceOf(InvalidRemoteBackendPolicyError)

    const secretBearing = {
      ...GRANTED,
      url: 'wss://should-not-persist.example',
      token: 'token-secret-value',
      cookie: 'cookie-secret-value',
      header: 'header-secret-value',
      pageData: 'page-secret-value',
    }
    let error: unknown
    try {
      await store().replace(
        secretBearing as unknown as RemoteBackendPolicyReplacement
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(InvalidRemoteBackendPolicyError)
    const serialized = JSON.stringify(backing)
    for (const secret of Object.values(secretBearing).filter(
      (value): value is string => typeof value === 'string'
    )) {
      expect(serialized).not.toContain(secret)
      expect((error as Error).message).not.toContain(secret)
    }
  })

  it('persists only the fixed policy schema and no raw remote URL', async () => {
    await store().replace(GRANTED)
    const raw = storedPolicies()[0] as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(
      [
        'version',
        'authorityKey',
        'authenticatedInstanceId',
        'remoteDataBoundaryAcceptedAt',
        'allowRequestCredentials',
        'allowCustomHeaders',
        'allowPageContent',
        'allowServerUrlProbe',
        'allowServerUrlResolve',
        'allowAutomaticTakeover',
      ].sort()
    )
    const serialized = JSON.stringify(backing)
    expect(serialized).not.toContain(SERVER_A.canonicalWsBase)
    expect(serialized).not.toContain('token-secret')
    expect(serialized).not.toContain('cookie-secret')
    expect(serialized).not.toContain('header-secret')
    expect(serialized).not.toContain('page-secret')
  })
})

describe('RemoteBackendPolicyStore persisted-data failure modes', () => {
  it('preserves an unknown future version, reads closed, and rejects writes', async () => {
    const future = {
      version: 99,
      opaque: { futureSecret: 'must-stay-opaque' },
    }
    backing[STORAGE_KEY] = future
    const policyStore = store()

    expect(await policyStore.get()).toEqual(defaultPolicy())
    await expect(policyStore.replace(GRANTED)).rejects.toBeInstanceOf(
      UnsupportedRemoteBackendPolicyVersionError
    )
    await expect(policyStore.clear()).rejects.toBeInstanceOf(
      UnsupportedRemoteBackendPolicyVersionError
    )
    expect(backing[STORAGE_KEY]).toEqual(future)
  })

  it.each([
    ['null', null],
    ['primitive', 'corrupt'],
    ['array', []],
    ['missing version', { policies: [] }],
    ['string version', { version: '1', policies: [] }],
    ['zero version', { version: 0, policies: [] }],
    ['missing policies', { version: 1 }],
    ['object policies', { version: 1, policies: {} }],
    ['extra container field', { version: 1, policies: [], token: 'opaque' }],
  ])(
    'preserves unscopable corrupt container %s and closes every scope',
    async (_label, value) => {
      backing[STORAGE_KEY] = value
      expect(await store(SERVER_A, 'instance-a').get()).toEqual(defaultPolicy())
      expect(await store(SERVER_B, 'instance-b').get()).toEqual(
        defaultPolicy(SERVER_B, 'instance-b')
      )
      await expect(store().replace(GRANTED)).rejects.toBeInstanceOf(
        CorruptRemoteBackendPolicyStoreError
      )
      await expect(store().clear()).rejects.toBeInstanceOf(
        CorruptRemoteBackendPolicyStoreError
      )
      expect(backing[STORAGE_KEY]).toEqual(value)
    }
  )

  it.each([
    ['missing authority', { version: 1 }],
    ['empty authority', { version: 1, authorityKey: '' }],
    ['non-string authority', { version: 1, authorityKey: 7 }],
    ['non-base64url authority', { version: 1, authorityKey: 'bad key!' }],
  ])(
    'preserves an unscopable policy row with %s and closes every scope',
    async (_label, policy) => {
      const corrupt = { version: 1, policies: [policy] }
      backing[STORAGE_KEY] = corrupt

      expect(await store().get()).toEqual(defaultPolicy())
      await expect(store().replace(GRANTED)).rejects.toBeInstanceOf(
        CorruptRemoteBackendPolicyStoreError
      )
      expect(backing[STORAGE_KEY]).toEqual(corrupt)
    }
  )

  it('fails only an attributable malformed authority closed', async () => {
    backing[STORAGE_KEY] = {
      version: 1,
      policies: [
        {
          ...persistedPolicy(SERVER_A, 'instance-a'),
          allowPageContent: 'yes',
        },
        persistedPolicy(SERVER_B, 'instance-b', {
          ...ALL_OFF,
          remoteDataBoundaryAcceptedAt: 1,
          allowServerUrlProbe: true,
        }),
      ],
    }

    expect(await store(SERVER_A, 'instance-a').get()).toEqual(defaultPolicy())
    expect(
      (await store(SERVER_B, 'instance-b').get()).allowServerUrlProbe
    ).toBe(true)
  })

  it('fails only a duplicated authority closed regardless of row order', async () => {
    backing[STORAGE_KEY] = {
      version: 1,
      policies: [
        persistedPolicy(SERVER_A, 'instance-a'),
        persistedPolicy(SERVER_B, 'instance-b'),
        persistedPolicy(SERVER_A, 'instance-a', ALL_OFF),
      ],
    }

    expect(await store(SERVER_A, 'instance-a').get()).toEqual(defaultPolicy())
    expect(await store(SERVER_B, 'instance-b').get()).toEqual({
      ...defaultPolicy(SERVER_B, 'instance-b'),
      ...GRANTED,
    })
    expect(storedPolicies()).toHaveLength(3)
  })

  it('treats a persisted grant without boundary consent as malformed only in its scope', async () => {
    backing[STORAGE_KEY] = {
      version: 1,
      policies: [
        persistedPolicy(SERVER_A, 'instance-a', {
          ...ALL_OFF,
          allowRequestCredentials: true,
        }),
        persistedPolicy(SERVER_B, 'instance-b', ALL_OFF),
      ],
    }

    expect(await store(SERVER_A, 'instance-a').get()).toEqual(defaultPolicy())
    expect(await store(SERVER_B, 'instance-b').get()).toEqual(
      defaultPolicy(SERVER_B, 'instance-b')
    )
  })

  it('repairs only the selected malformed/duplicated authority on replace', async () => {
    const unrelated = {
      ...persistedPolicy(SERVER_B, 'instance-b', ALL_OFF),
      remoteDataBoundaryAcceptedAt: 'malformed-but-attributable',
    }
    backing[STORAGE_KEY] = {
      version: 1,
      policies: [
        unrelated,
        persistedPolicy(SERVER_A, 'old-a'),
        { ...persistedPolicy(SERVER_A, 'other-a'), extra: true },
      ],
    }

    await store(SERVER_A, 'new-a').replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 10,
      allowAutomaticTakeover: true,
    })

    expect(storedPolicies()[0]).toEqual(unrelated)
    expect(storedPolicies()).toHaveLength(2)
    expect((await store(SERVER_A, 'new-a').get()).allowAutomaticTakeover).toBe(
      true
    )
    expect(await store(SERVER_B, 'instance-b').get()).toEqual(
      defaultPolicy(SERVER_B, 'instance-b')
    )
  })

  it('returns a copy so callers cannot mutate persisted policy in memory', async () => {
    const policyStore = store()
    await policyStore.replace(GRANTED)
    const result = await policyStore.get()
    ;(result as { allowPageContent: boolean }).allowPageContent = false

    expect((await policyStore.get()).allowPageContent).toBe(true)
    expect(
      (storedPolicies()[0] as { allowPageContent: boolean }).allowPageContent
    ).toBe(true)
  })
})

describe('RemoteBackendPolicyStore mutation isolation and queue', () => {
  it('clear removes only the target authority, regardless of bound instance', async () => {
    const a = store(SERVER_A, 'old-a')
    const b = store(SERVER_B, 'instance-b')
    await a.replace(GRANTED)
    await b.replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 1,
      allowServerUrlResolve: true,
    })
    const rawB = structuredClone(storedPolicies()[1])

    await store(SERVER_A, 'new-a').clear()

    expect(await a.get()).toEqual(defaultPolicy(SERVER_A, 'old-a'))
    expect(storedPolicies()).toEqual([rawB])
    expect((await b.get()).allowServerUrlResolve).toBe(true)
  })

  it('authority cleanup clears rows without needing an authenticated instance id', async () => {
    await store(SERVER_A, 'instance-a').replace(GRANTED)
    await store(SERVER_B, 'instance-b').replace({
      ...ALL_OFF,
      remoteDataBoundaryAcceptedAt: 1,
      allowCustomHeaders: true,
    })

    await clearRemoteBackendPoliciesForAuthority(SERVER_A)

    expect(await store(SERVER_A, 'instance-a').get()).toEqual(
      defaultPolicy(SERVER_A, 'instance-a')
    )
    expect((await store(SERVER_B, 'instance-b').get()).allowCustomHeaders).toBe(
      true
    )
  })

  it('clear repairs duplicated target rows and preserves unrelated rows exactly', async () => {
    const rawB = persistedPolicy(SERVER_B, 'instance-b', ALL_OFF)
    backing[STORAGE_KEY] = {
      version: 1,
      policies: [
        persistedPolicy(SERVER_A, 'one'),
        rawB,
        { ...persistedPolicy(SERVER_A, 'two'), allowPageContent: 'bad' },
      ],
    }

    await store(SERVER_A, 'current').clear()

    expect(storedPolicies()).toEqual([rawB])
  })

  it('clear of the last target removes the storage key', async () => {
    const policyStore = store()
    await policyStore.replace(GRANTED)
    await policyStore.clear()

    expect(Object.hasOwn(backing, STORAGE_KEY)).toBe(false)
    expect(browser.storage.local.remove).toHaveBeenCalledWith(STORAGE_KEY)
  })

  it('a no-op clear does not rewrite an unrelated container', async () => {
    const bPolicy = persistedPolicy(SERVER_B, 'instance-b', ALL_OFF)
    const current = { version: 1, policies: [bPolicy] }
    backing[STORAGE_KEY] = current

    await store(SERVER_A, 'instance-a').clear()

    expect(backing[STORAGE_KEY]).toBe(current)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
  })

  it('serializes concurrent writes from separate instances without losing a scope', async () => {
    const a = store(SERVER_A, 'instance-a')
    const b = store(SERVER_B, 'instance-b')
    await Promise.all([
      a.replace({
        ...ALL_OFF,
        remoteDataBoundaryAcceptedAt: 1,
        allowRequestCredentials: true,
      }),
      b.replace({
        ...ALL_OFF,
        remoteDataBoundaryAcceptedAt: 2,
        allowCustomHeaders: true,
      }),
    ])

    expect((await a.get()).allowRequestCredentials).toBe(true)
    expect((await b.get()).allowCustomHeaders).toBe(true)
    expect(storedPolicies()).toHaveLength(2)
  })

  it('orders overlapping clear and replace operations deterministically', async () => {
    const a = store(SERVER_A, 'instance-a')
    await a.replace(GRANTED)

    await Promise.all([a.clear(), a.replace(ALL_OFF)])
    expect(await a.get()).toEqual(defaultPolicy())
    expect(storedPolicies()).toHaveLength(1)

    await Promise.all([a.replace(GRANTED), a.clear()])
    expect(await a.get()).toEqual(defaultPolicy())
    expect(Object.hasOwn(backing, STORAGE_KEY)).toBe(false)
  })

  it('keeps the module queue usable after a storage write failure', async () => {
    const persistentSet = browser.storage.local.set
    browser.storage.local.set = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(persistentSet)
    const a = store(SERVER_A, 'instance-a')
    const b = store(SERVER_B, 'instance-b')

    await expect(a.replace(GRANTED)).rejects.toThrow('storage unavailable')
    await expect(b.replace(ALL_OFF)).resolves.toBeUndefined()
    expect(await a.get()).toEqual(defaultPolicy())
    expect(await b.get()).toEqual(defaultPolicy(SERVER_B, 'instance-b'))
    expect(storedPolicies()).toHaveLength(1)
  })
})

describe('lease-bound remote policy facade', () => {
  it('routes reads and every mutation through the supplied critical section', async () => {
    const endpointStore = new EndpointConfigStore()
    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'A',
          url: SERVER_A.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const lifecycle = new EndpointCatalogService(endpointStore, {
      retire: async () => undefined,
    })
    const lease = await lifecycle.issueBackendAttemptLease('server-a')
    const capability = lifecycle.bindBackendAttemptLease(lease)
    const policy = createLeaseBoundRemoteBackendPolicyStore(
      SERVER_A,
      'instance-a',
      capability
    )

    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'A',
          url: SERVER_A.canonicalWsBase,
          revision: 1,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })

    await expect(policy.get()).rejects.toThrow('stale')
    await expect(policy.replace(ALL_OFF)).rejects.toThrow('stale')
    await expect(policy.clear()).rejects.toThrow('stale')
    expect(backing[STORAGE_KEY]).toBeUndefined()
  })
})
