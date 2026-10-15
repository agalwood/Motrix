import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CorruptEndpointConfigStoreError,
  EndpointConfigStore,
  LOCAL_ENDPOINT_ID,
  resolveActiveEndpoint,
  resolveEndpointById,
  UnsupportedEndpointConfigVersionError,
} from '@/background/EndpointConfigStore'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.endpointConfig'

let backing: Record<string, unknown> = {}

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

function config(
  activeEndpointId = LOCAL_ENDPOINT_ID,
  servers: Array<ReturnType<typeof server>> = []
) {
  return {
    version: 3 as const,
    activeEndpointId,
    servers,
    cleanupTombstones: [],
  }
}

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

describe('EndpointConfigStore', () => {
  it('returns the empty v3 catalogue when nothing is stored', async () => {
    const store = new EndpointConfigStore()
    expect(await store.get()).toEqual(config())
  })

  it('round-trips multiple servers and canonicalizes their URLs', async () => {
    const store = new EndpointConfigStore()
    await store.setForTest({
      version: 3,
      activeEndpointId: 'office',
      servers: [
        server('office', ' Office ', 'wss://MOTRIX.Example:443/bridge/'),
        server('nas', 'NAS', 'ws://NAS.Local:80/bridge/'),
      ],
      cleanupTombstones: [],
    })

    expect(await store.get()).toEqual({
      version: 3,
      activeEndpointId: 'office',
      servers: [
        server('office', 'Office', 'wss://motrix.example/bridge'),
        server('nas', 'NAS', 'ws://nas.local/bridge'),
      ],
      cleanupTombstones: [],
    })
  })

  it.each([
    ['HTTP URL', 'https://motrix.example'],
    ['userinfo', 'wss://user:secret@motrix.example'],
    ['query', 'wss://motrix.example?token=legacy'],
    ['fragment', 'wss://motrix.example#bridge'],
    ['leading whitespace', ' wss://motrix.example'],
    ['trailing whitespace', 'wss://motrix.example '],
    ['embedded whitespace', 'wss://motrix.example/a b'],
    ['backslash', 'wss://motrix.example\\admin'],
    ['ASCII control', 'wss://motrix.example/\u0001admin'],
    ['encoded slash', 'wss://motrix.example/%2fadmin'],
    ['encoded backslash', 'wss://motrix.example/%5Cadmin'],
    ['oversized URL', `wss://motrix.example/${'a'.repeat(4096)}`],
    ['malformed URL', 'not a URL'],
  ])('rejects %s server URLs on write', async (_label, url) => {
    const store = new EndpointConfigStore()
    await expect(
      store.setForTest({
        version: 3,
        activeEndpointId: 'bad',
        servers: [server('bad', 'Bad', url)],
        cleanupTombstones: [],
      })
    ).rejects.toThrow()
  })

  it.each(['', '   ', ' endpoint', 'endpoint ', '服务器', 'a'.repeat(129)])(
    'rejects invalid endpoint id %j on write',
    async (id) => {
      await expect(
        new EndpointConfigStore().setForTest({
          version: 3,
          activeEndpointId: id,
          servers: [server(id, 'Bad', 'wss://motrix.example')],
          cleanupTombstones: [],
        })
      ).rejects.toThrow()
    }
  )

  it.each([
    { mode: 'local' },
    { mode: 'remote', remoteUrl: 'ws://nas.local:8888' },
    { mode: 'remote', remoteUrl: 'wss://nas.example' },
    { mode: 'remote' },
    { mode: 'remote', remoteUrl: 'wss://nas.example', opaque: true },
    { mode: 'local', remoteUrl: 'wss://nas.example', opaque: true },
  ])('clears an obsolete development record %#', async (obsolete) => {
    backing[STORAGE_KEY] = obsolete
    const store = new EndpointConfigStore()

    expect(await store.get()).toEqual(config())
    expect(await store.getForLifecycleMutation()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBeUndefined()
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).toHaveBeenCalledWith(STORAGE_KEY)
  })

  it('shows local read fallback but rejects lifecycle capture when a stored active id is unknown', async () => {
    const corrupt = {
      version: 3,
      activeEndpointId: 'missing',
      servers: [server('nas', 'NAS', 'wss://nas.example:8443')],
      cleanupTombstones: [],
    }
    backing[STORAGE_KEY] = corrupt
    const store = new EndpointConfigStore()

    expect((await store.get()).activeEndpointId).toBe(LOCAL_ENDPOINT_ID)
    await expect(store.getForLifecycleMutation()).rejects.toBeInstanceOf(
      CorruptEndpointConfigStoreError
    )
    expect(backing[STORAGE_KEY]).toBe(corrupt)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('rejects a caller write whose active server id is unknown', async () => {
    await expect(
      new EndpointConfigStore().setForTest({
        version: 3,
        activeEndpointId: 'missing',
        servers: [server('nas', 'NAS', 'wss://nas.example:8443')],
        cleanupTombstones: [],
      })
    ).rejects.toThrow('active endpoint id is unknown')
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('rejects duplicate canonical URLs instead of aliasing endpoint ids', async () => {
    const store = new EndpointConfigStore()
    await expect(
      store.setForTest({
        version: 3,
        activeEndpointId: 'duplicate',
        servers: [
          server('primary', 'Primary', 'wss://motrix.example/bridge'),
          server('duplicate', 'Duplicate', 'wss://MOTRIX.example:443/bridge/'),
        ],
        cleanupTombstones: [],
      })
    ).rejects.toThrow('server URL is duplicated')
  })

  it('clears an obsolete versioned development catalogue', async () => {
    const obsolete = {
      version: 2,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://nas.example:8443',
          revision: 99,
          state: 'cleanup-pending',
        },
      ],
    }
    backing[STORAGE_KEY] = obsolete
    const store = new EndpointConfigStore()

    expect(await store.get()).toEqual(config())
    expect(await store.getForLifecycleMutation()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBeUndefined()
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).toHaveBeenCalledWith(STORAGE_KEY)
  })

  it('preserves an unknown future schema while reads fail closed to local', async () => {
    const future = {
      version: 99,
      activeEndpointId: 'future-server',
      servers: [
        {
          id: 'future-server',
          name: 'Future',
          url: 'wss://future.example',
          futureRoutingProof: 'opaque',
        },
      ],
    }
    backing[STORAGE_KEY] = future

    expect(await new EndpointConfigStore().get()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBe(future)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
  })

  it('rejects mutation without overwriting an unknown future schema', async () => {
    const future = {
      version: 99,
      activeEndpointId: 'future-server',
      servers: [],
    }
    backing[STORAGE_KEY] = future

    await expect(
      new EndpointConfigStore().setForTest({
        ...config(),
      })
    ).rejects.toBeInstanceOf(UnsupportedEndpointConfigVersionError)
    expect(backing[STORAGE_KEY]).toBe(future)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
  })

  it('does not disguise a future version as legacy when it carries legacy fields', async () => {
    const future = {
      version: 99,
      mode: 'remote',
      remoteUrl: 'wss://future.example',
    }
    backing[STORAGE_KEY] = future

    expect(await new EndpointConfigStore().get()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBe(future)
  })

  it('falls back to default when stored value is malformed', async () => {
    const store = new EndpointConfigStore()
    await browser.storage.local.set({ [STORAGE_KEY]: 'garbage' })
    expect(await store.get()).toEqual(config())
  })

  it.each([
    [
      'missing server revision',
      {
        version: 3,
        activeEndpointId: 'a',
        servers: [
          { id: 'a', name: 'A', url: 'wss://a.example', state: 'ready' },
        ],
        cleanupTombstones: [],
      },
    ],
    [
      'missing server state',
      {
        version: 3,
        activeEndpointId: 'a',
        servers: [{ id: 'a', name: 'A', url: 'wss://a.example', revision: 0 }],
        cleanupTombstones: [],
      },
    ],
    [
      'extra server field',
      {
        version: 3,
        activeEndpointId: 'a',
        servers: [
          {
            ...server('a', 'A', 'wss://a.example'),
            futureAuthorityProof: 'opaque',
          },
        ],
        cleanupTombstones: [],
      },
    ],
    ['extra container field', { ...config(), futureLifecycleState: 'opaque' }],
    [
      'extra tombstone field',
      {
        version: 3,
        activeEndpointId: 'local',
        servers: [],
        cleanupTombstones: [
          {
            endpointId: 'a',
            canonicalWsBase: 'wss://a.example',
            invalidatedRevision: 0,
            futureCleanupProof: 'opaque',
          },
        ],
      },
    ],
  ])('preserves corrupt v3 with %s', async (_label, corrupt) => {
    backing[STORAGE_KEY] = corrupt

    expect(await new EndpointConfigStore().get()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBe(corrupt)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('rejects inherited lifecycle fields', async () => {
    const inheritedServer = Object.assign(
      Object.create({ revision: 0, state: 'ready' }) as Record<string, unknown>,
      { id: 'a', name: 'A', url: 'wss://a.example' }
    )
    const corrupt = {
      version: 3,
      activeEndpointId: 'a',
      servers: [inheritedServer],
      cleanupTombstones: [],
    }
    backing[STORAGE_KEY] = corrupt

    expect(await new EndpointConfigStore().get()).toEqual(config())
    expect(backing[STORAGE_KEY]).toBe(corrupt)
  })

  it('rejects every mutation while preserving a corrupt v3 tombstone', async () => {
    const corrupt = {
      version: 3,
      activeEndpointId: 'local',
      servers: [],
      cleanupTombstones: [
        {
          endpointId: 'retired',
          canonicalWsBase: 'wss://old.example',
        },
      ],
    }
    backing[STORAGE_KEY] = corrupt

    await expect(
      new EndpointConfigStore().setForTest(config())
    ).rejects.toBeInstanceOf(CorruptEndpointConfigStoreError)
    expect(backing[STORAGE_KEY]).toBe(corrupt)
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.storage.local.remove).not.toHaveBeenCalled()
  })

  it('serializes a current read before a concurrent explicit update', async () => {
    await browser.storage.local.set({ [STORAGE_KEY]: config() })
    const store = new EndpointConfigStore()
    const next = {
      version: 3 as const,
      activeEndpointId: 'new',
      servers: [server('new', 'New', 'wss://new.example')],
      cleanupTombstones: [],
    }

    await Promise.all([store.get(), store.setForTest(next)])

    expect(await store.get()).toEqual(next)
  })
})

describe('endpoint resolution', () => {
  const configValue = config('nas', [
    server('nas', 'NAS', 'wss://nas.example:8443'),
  ])

  it('resolves the active server to an immutable connection snapshot', () => {
    expect(resolveActiveEndpoint(configValue)).toEqual({
      mode: 'remote',
      remoteUrl: 'wss://nas.example:8443',
      endpointId: 'nas',
      revision: 0,
    })
  })

  it('resolves local explicitly and rejects unknown ids', () => {
    expect(resolveEndpointById(configValue, LOCAL_ENDPOINT_ID)).toEqual({
      mode: 'local',
    })
    expect(resolveEndpointById(configValue, 'missing')).toBeNull()
  })

  it('resolves a validated WS endpoint without rewriting its scheme', () => {
    const wsConfig = {
      version: 3,
      activeEndpointId: 'nas',
      servers: [server('nas', 'NAS', 'ws://nas.local:8888')],
      cleanupTombstones: [],
    } as const

    expect(resolveEndpointById(wsConfig, 'nas')).toEqual({
      mode: 'remote',
      remoteUrl: 'ws://nas.local:8888',
      endpointId: 'nas',
      revision: 0,
    })
    expect(resolveActiveEndpoint(wsConfig)).toEqual({
      mode: 'remote',
      remoteUrl: 'ws://nas.local:8888',
      endpointId: 'nas',
      revision: 0,
    })
  })
})
