import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fixture from '@shared/schemas/registry.fixture.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REGISTRY_BYTES,
  RegistryClient,
  type RegistryClientOptions,
} from './registry-client'

type FetchStep =
  | {
      status: 200
      body?: unknown
      bytes?: Uint8Array
      etag?: string
      contentLength?: string
    }
  | { status: 304 }
  | { status: 500 }
  | { error: true }

function makeFetch(steps: FetchStep[]) {
  const calls: { headers: Record<string, string>; signal?: AbortSignal }[] = []
  const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal ?? undefined,
    })
    const step = steps.shift()
    if (!step) throw new Error('unexpected fetch call')
    if ('error' in step) throw new Error('network down')

    const headers = new Headers()
    if (step.status === 200 && step.etag) headers.set('etag', step.etag)
    if (step.status === 200 && step.contentLength) {
      headers.set('content-length', step.contentLength)
    }
    const body: BodyInit | null =
      step.status === 200
        ? ((step.bytes as unknown as BodyInit | undefined) ??
          JSON.stringify(step.body ?? fixture))
        : null
    return new Response(body, { status: step.status, headers })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function currentEnvelope(
  raw: unknown,
  fetchedAt: number,
  etag: string | null = null
) {
  return { cacheFormat: 2, etag, fetchedAt, raw }
}

describe('RegistryClient', () => {
  let cacheDir: string
  let cachePath: string
  let clock: { value: number }
  const HOUR = 60 * 60 * 1000

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'registry-client-'))
    cachePath = path.join(cacheDir, 'registry-cache.json')
    clock = { value: 1_000_000 }
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(cacheDir, { recursive: true, force: true })
  })

  function makeClient(
    fetchImpl: typeof fetch,
    options: Partial<RegistryClientOptions> = {}
  ) {
    return new RegistryClient({
      cachePath,
      fetchImpl,
      ttlMs: 6 * HOUR,
      now: () => clock.value,
      ...options,
    })
  }

  it('rejects a legacy file envelope, fetches unconditionally, and overwrites in format 2', async () => {
    await writeFile(
      cachePath,
      JSON.stringify({
        etag: '"legacy"',
        fetchedAt: clock.value,
        file: fixture,
      })
    )
    const { impl, calls } = makeFetch([{ status: 200, etag: '"v2"' }])

    expect((await makeClient(impl).load())?.plugins).toHaveLength(3)
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()

    const envelope = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(envelope).toMatchObject({
      cacheFormat: 2,
      etag: '"v2"',
      fetchedAt: clock.value,
    })
    expect(envelope.raw.plugins).toHaveLength(3)
    expect(envelope.file).toBeUndefined()
  })

  it('preserves unknown raw fields through restart, conditional 304, and persistence', async () => {
    const future = structuredClone(fixture) as Record<string, unknown>
    future.futureRoot = { enabled: true }
    const first = makeFetch([{ status: 200, body: future, etag: '"future"' }])
    await makeClient(first.impl).load()

    clock.value += 7 * HOUR
    const second = makeFetch([{ status: 304 }])
    const rebooted = makeClient(second.impl)
    const loaded = await rebooted.load()

    expect(loaded?.futureRoot).toEqual({ enabled: true })
    expect(second.calls[0]?.headers['if-none-match']).toBe('"future"')
    const persisted = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(persisted.raw.futureRoot).toEqual({ enabled: true })
    expect(persisted.fetchedAt).toBe(clock.value)
  })

  it('serves a current cache from memory within TTL without refetching', async () => {
    const { impl } = makeFetch([{ status: 200 }])
    const client = makeClient(impl)
    await client.load()
    clock.value += HOUR
    await client.load()
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('boots from a valid current-format disk cache without touching the network', async () => {
    await writeFile(
      cachePath,
      JSON.stringify(currentEnvelope(fixture, clock.value, '"disk"'))
    )
    const { impl } = makeFetch([])
    expect((await makeClient(impl).load())?.plugins).toHaveLength(3)
    expect(impl).not.toHaveBeenCalled()
  })

  it('discards corrupt or schema-invalid disk data and clears its ETag', async () => {
    await writeFile(
      cachePath,
      JSON.stringify(
        currentEnvelope({ version: 999, plugins: [] }, 0, '"invalid"')
      )
    )
    const { impl, calls } = makeFetch([{ status: 200 }])
    expect((await makeClient(impl).load())?.plugins).toHaveLength(3)
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
  })

  it('discards a cache-format-2 envelope containing a v1 registry', async () => {
    await writeFile(
      cachePath,
      JSON.stringify(
        currentEnvelope({ ...fixture, version: 1 }, clock.value, '"v1"')
      )
    )
    const { impl, calls } = makeFetch([{ status: 200, etag: '"v2"' }])

    expect((await makeClient(impl).load())?.version).toBe(2)
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
  })

  it('rejects an oversized disk cache before allocating readFile', async () => {
    const readFileImpl = vi.fn(async () => {
      throw new Error('must not read oversized cache')
    })
    const { impl, calls } = makeFetch([{ status: 200 }])
    const client = makeClient(impl, {
      statImpl: async () => ({ size: MAX_REGISTRY_BYTES + 64 * 1024 + 1 }),
      readFileImpl,
    })

    expect((await client.load())?.plugins).toHaveLength(3)
    expect(readFileImpl).not.toHaveBeenCalled()
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
  })

  it('shares one deferred disk read across concurrent load calls', async () => {
    let release!: (value: string) => void
    const deferred = new Promise<string>((resolve) => {
      release = resolve
    })
    const readFileImpl = vi.fn(() => deferred)
    const { impl } = makeFetch([])
    const client = makeClient(impl, {
      statImpl: async () => ({ size: 1 }),
      readFileImpl,
    })

    const first = client.load()
    const second = client.load()
    await Promise.resolve()
    expect(impl).not.toHaveBeenCalled()
    release(JSON.stringify(currentEnvelope(fixture, clock.value)))

    expect(
      (await Promise.all([first, second])).map((file) => file?.version)
    ).toEqual([2, 2])
    expect(readFileImpl).toHaveBeenCalledTimes(1)
    expect(impl).not.toHaveBeenCalled()
  })

  it('shares deferred disk initialization and one network request across load/refresh', async () => {
    let release!: (value: string) => void
    const deferred = new Promise<string>((resolve) => {
      release = resolve
    })
    const readFileImpl = vi.fn(() => deferred)
    const { impl, calls } = makeFetch([{ status: 304 }])
    const client = makeClient(impl, {
      statImpl: async () => ({ size: 1 }),
      readFileImpl,
    })

    const loaded = client.load()
    const refreshed = client.refresh()
    await Promise.resolve()
    expect(impl).not.toHaveBeenCalled()
    release(JSON.stringify(currentEnvelope(fixture, 0, '"disk"')))

    expect(
      (await Promise.all([loaded, refreshed])).map((file) => file?.version)
    ).toEqual([2, 2])
    expect(readFileImpl).toHaveBeenCalledTimes(1)
    expect(impl).toHaveBeenCalledTimes(1)
    expect(calls[0]?.headers['if-none-match']).toBe('"disk"')
  })

  it('keeps current-format last-good on network and schema failures', async () => {
    const { impl } = makeFetch([
      { status: 200 },
      { error: true },
      { status: 200, body: { version: 999, nope: true } },
    ])
    const client = makeClient(impl)
    await client.load()
    expect((await client.refresh())?.plugins).toHaveLength(3)
    expect((await client.refresh())?.plugins).toHaveLength(3)
  })

  it('returns null when there is no cache and the network is down', async () => {
    const { impl } = makeFetch([{ error: true }])
    expect(await makeClient(impl).load()).toBeNull()
  })

  it('cancels a non-ok registry response body', async () => {
    const cancel = vi.fn()
    const impl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('server error'))
            },
            cancel,
          }),
          { status: 500 }
        )
      )
    ) as unknown as typeof fetch

    expect(await makeClient(impl).load()).toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    let signal: AbortSignal | undefined
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(MAX_REGISTRY_BYTES + 1) },
      })
    }) as unknown as typeof fetch

    expect(await makeClient(impl).load()).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('aborts and rejects a streamed response over 4 MiB', async () => {
    let signal: AbortSignal | undefined
    let cancelled = false
    const bytes = new Uint8Array(MAX_REGISTRY_BYTES + 1).fill(0x20)
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
          },
          cancel() {
            cancelled = true
          },
        })
      )
    }) as unknown as typeof fetch

    expect(await makeClient(impl).load()).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const { impl } = makeFetch([
      {
        status: 200,
        bytes: new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      },
    ])
    expect(await makeClient(impl).load()).toBeNull()
  })

  it('uses one 15-second deadline for response headers and the full body', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let cancelled = false
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => {}),
          cancel() {
            cancelled = true
          },
        })
      )
    }) as unknown as typeof fetch

    const pending = makeClient(impl, {
      statImpl: async () => {
        throw new Error('no cache')
      },
    }).load()
    await vi.advanceTimersByTimeAsync(0)
    expect(impl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await pending).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('aborts when response headers do not arrive before the deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const impl = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch

    const pending = makeClient(impl, {
      statImpl: async () => {
        throw new Error('no cache')
      },
    }).load()
    await vi.advanceTimersByTimeAsync(0)
    expect(impl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await pending).toBeNull()
    expect(signal?.aborted).toBe(true)
  })

  it('cancels a late response from a fetch implementation that ignores abort', async () => {
    vi.useFakeTimers()
    let resolveResponse!: (response: Response) => void
    const deferred = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const impl = vi.fn(() => deferred) as unknown as typeof fetch
    const client = makeClient(impl, {
      statImpl: async () => {
        throw new Error('no cache')
      },
    })

    const pending = client.load()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toBeNull()

    const cancel = vi.fn()
    resolveResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'))
          },
          cancel,
        })
      )
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('annotates entries with the host compatibility gate', async () => {
    const { impl } = makeFetch([{ status: 200 }])
    const client = makeClient(impl)

    const listed = await client.list('2.0.5')
    expect(listed.map((plugin) => [plugin.id, plugin.compatible])).toEqual([
      ['example.archive-unpacker', false],
      ['example.minimal', true],
      ['motrix.url-resolver', true],
    ])

    expect(
      (await client.get('example.archive-unpacker', '2.2.0'))?.compatible
    ).toBe(true)
    expect(await client.get('example.unknown', '2.2.0')).toBeNull()
  })
})
