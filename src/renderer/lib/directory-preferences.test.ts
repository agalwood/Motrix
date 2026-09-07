import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { MutateDirectoryPreferencesRequest } from '@shared/schemas/directory-preferences'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_PREFERENCES_TIMEOUT,
  DirectoryPreferencesStore,
  ServerDirectoryLocationsStore,
  useServerDirectoryLocations,
} from './directory-preferences'
import { transport } from './transport'
import type {
  EventListener,
  Transport,
  TransportConnectionListener,
} from './transport/types'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'web' },
}))

const success = (value: unknown) => ({ ok: true, value })
const empty = { favorites: [], recent: [] }
const saved = { favorites: ['/saved'], recent: ['/recent'] }
const places = {
  common: [
    { kind: 'default', path: '/downloads' },
    { kind: 'home', path: '/downloads' },
  ],
  favorites: [
    { name: 'Saved', path: '/saved', sourcePaths: ['/real/saved', '/saved'] },
  ],
  recent: [],
}
const flush = () => vi.advanceTimersByTimeAsync(0)
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const disposables: { dispose(): void }[] = []
function harness() {
  const callbacks = new Map<string, EventListener>()
  let connection: TransportConnectionListener | undefined
  const responses = new Map<string, unknown[]>()
  const bridge = {
    invoke: vi.fn<Transport['invoke']>(async (channel) => {
      expect(callbacks.has(Events.DirectoryPreferencesChanged)).toBe(true)
      const queue = responses.get(channel)
      if (queue?.length) return queue.shift()
      if (channel === Queries.ListServerDirectoryLocations)
        return success(places)
      return success(empty)
    }),
    on: vi.fn<Transport['on']>((channel, listener) => {
      callbacks.set(channel, listener)
    }),
    off: vi.fn<Transport['off']>((channel, listener) => {
      if (callbacks.get(channel) === listener) callbacks.delete(channel)
    }),
    onConnectionChange: vi.fn<NonNullable<Transport['onConnectionChange']>>(
      (listener) => {
        connection = listener
        return () => {
          connection = undefined
        }
      }
    ),
  }
  const preferences = new DirectoryPreferencesStore(bridge)
  disposables.push(preferences)
  return {
    bridge,
    preferences,
    locations(
      options?: ConstructorParameters<typeof ServerDirectoryLocationsStore>[1]
    ) {
      const store = new ServerDirectoryLocationsStore(bridge, options)
      disposables.push(store)
      return store
    },
    queue(channel: string, ...values: unknown[]) {
      responses.set(channel, [...(responses.get(channel) ?? []), ...values])
    },
    event(value: unknown) {
      callbacks.get(Events.DirectoryPreferencesChanged)?.(value)
    },
    reconnect() {
      connection?.({ state: 'connected' })
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  for (const disposable of disposables.splice(0)) disposable.dispose()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('DirectoryPreferencesStore', () => {
  it('preserves equal preference references and does not notify an unchanged event snapshot', async () => {
    const h = harness()
    const listener = vi.fn()
    h.preferences.subscribe(listener)
    await flush()
    const snapshot = h.preferences.getSnapshot()
    listener.mockClear()
    h.event(structuredClone(empty))
    expect(h.preferences.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('provides the actual committed response for refresh causality even after a newer event', async () => {
    const h = harness()
    const response = deferred()
    h.queue(Commands.MutateDirectoryPreferences, response.promise)
    const onCommitted = vi.fn()
    const mutation = h.preferences.mutate(
      { action: 'addFavorite', path: '/saved' },
      onCommitted
    )
    await flush()
    h.event(empty)
    response.resolve(success(saved))
    expect(await mutation).toBe(true)
    expect(onCommitted).toHaveBeenCalledWith(saved)
    expect(h.preferences.getSnapshot().preferences).toEqual(empty)
  })

  it('loads saved records on the first UI subscription even if background recording failed earlier', async () => {
    const h = harness()
    h.queue(Commands.MutateDirectoryPreferences, {
      ok: false,
      error: { code: 'permissionDenied' },
    })
    expect(
      await h.preferences.mutate({ action: 'recordRecent', path: '/denied' })
    ).toBe(false)
    h.queue(Queries.GetDirectoryPreferences, success(saved))
    h.preferences.subscribe(vi.fn())
    await flush()
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: saved,
      loading: false,
      error: null,
    })
  })

  it('subscribes before reading and never overwrites a newer event with an older read', async () => {
    const h = harness()
    const response = deferred()
    h.queue(Queries.GetDirectoryPreferences, response.promise)
    h.preferences.subscribe(vi.fn())
    await flush()
    h.event(saved)
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: saved,
      loading: false,
      error: null,
    })
    response.resolve(success(empty))
    await flush()
    expect(h.preferences.getSnapshot().preferences).toEqual(saved)
    expect(h.bridge.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetDirectoryPreferences,
      {}
    )
  })

  it('invalidates mutation-return snapshots on a newer removal event', async () => {
    const h = harness()
    await h.preferences.refresh()
    const response = deferred()
    h.queue(Commands.MutateDirectoryPreferences, response.promise)
    const mutation = h.preferences.mutate({
      action: 'addFavorite',
      path: '/saved',
    })
    await flush()
    h.event(empty)
    response.resolve(success(saved))
    expect(await mutation).toBe(true)
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: empty,
      loading: false,
      error: null,
    })
  })

  it('preserves literal paths and exposes a localized host failure without rejecting', async () => {
    const h = harness()
    h.queue(Commands.MutateDirectoryPreferences, {
      ok: false,
      error: { code: 'limitReached' },
    })
    await expect(
      h.preferences.mutate({ action: 'addFavorite', path: '/ space ' })
    ).resolves.toBe(false)
    expect(h.bridge.invoke).toHaveBeenCalledWith(
      Commands.MutateDirectoryPreferences,
      { action: 'addFavorite', path: '/ space ' }
    )
    expect(h.preferences.getSnapshot()).toMatchObject({
      error: 'limitReached',
      loading: false,
    })
  })

  it('rejects malformed action envelopes before transport', async () => {
    const h = harness()
    const invalid = {
      action: 'clearRecent',
      extra: true,
    } as unknown as MutateDirectoryPreferencesRequest
    expect(await h.preferences.mutate(invalid)).toBe(false)
    expect(h.bridge.invoke).not.toHaveBeenCalled()
    expect(h.preferences.getSnapshot().error).toBe('invalidPath')
  })

  it('treats a mutation timeout as unknown, refreshes authority, and never replays or accepts its late snapshot', async () => {
    const h = harness()
    await h.preferences.refresh()
    const response = deferred()
    h.queue(Commands.MutateDirectoryPreferences, response.promise)
    h.queue(Queries.GetDirectoryPreferences, success(saved))
    const mutation = h.preferences.mutate({
      action: 'recordRecent',
      path: '/recent',
    })
    await flush()
    expect(h.preferences.getSnapshot().preferences).toEqual(empty)
    await vi.advanceTimersByTimeAsync(DIRECTORY_PREFERENCES_TIMEOUT)
    expect(await mutation).toBe(false)
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: saved,
      loading: false,
      error: 'unavailable',
    })
    response.resolve(success(empty))
    await flush()
    expect(h.preferences.getSnapshot().preferences).toEqual(saved)
    expect(
      h.bridge.invoke.mock.calls.filter(
        ([channel]) => channel === Commands.MutateDirectoryPreferences
      )
    ).toHaveLength(1)
    expect(
      h.bridge.invoke.mock.calls.filter(
        ([channel]) => channel === Queries.GetDirectoryPreferences
      )
    ).toHaveLength(2)
  })

  it('bounds initial reads and recovers through an explicit refresh', async () => {
    const h = harness()
    h.queue(
      Queries.GetDirectoryPreferences,
      new Promise(() => {}),
      success(saved)
    )
    const read = h.preferences.refresh()
    await vi.advanceTimersByTimeAsync(DIRECTORY_PREFERENCES_TIMEOUT)
    await read
    expect(h.preferences.getSnapshot()).toMatchObject({
      loading: false,
      error: 'unavailable',
    })
    await h.preferences.refresh()
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: saved,
      loading: false,
      error: null,
    })
  })

  it('refreshes after reconnect and ignores the previous connection’s pending query', async () => {
    const h = harness()
    const response = deferred()
    h.queue(Queries.GetDirectoryPreferences, response.promise, success(saved))
    h.preferences.subscribe(vi.fn())
    await flush()
    h.reconnect()
    await flush()
    response.resolve(success(empty))
    await flush()
    expect(h.preferences.getSnapshot().preferences).toEqual(saved)
  })

  it('counts overlapping mutations without reviving an older successful snapshot', async () => {
    const h = harness()
    const first = deferred()
    const second = deferred()
    h.queue(Commands.MutateDirectoryPreferences, first.promise, second.promise)
    const a = h.preferences.mutate({ action: 'addFavorite', path: '/saved' })
    const b = h.preferences.mutate({ action: 'clearRecent' })
    await flush()
    second.resolve(success(empty))
    expect(await b).toBe(true)
    expect(h.preferences.getSnapshot().loading).toBe(true)
    first.resolve(success(saved))
    expect(await a).toBe(true)
    expect(h.preferences.getSnapshot()).toEqual({
      preferences: empty,
      loading: false,
      error: null,
    })
  })

  it('removes the exact event callback on disposal and drops pending results', async () => {
    const h = harness()
    const response = deferred()
    h.queue(Queries.GetDirectoryPreferences, response.promise)
    const listener = vi.fn()
    h.preferences.subscribe(listener)
    await flush()
    const callback = h.bridge.on.mock.calls[0][1]
    h.preferences.dispose()
    listener.mockClear()
    response.resolve(success(saved))
    h.event(saved)
    h.reconnect()
    await flush()
    expect(listener).not.toHaveBeenCalled()
    expect(h.bridge.off).toHaveBeenCalledWith(
      Events.DirectoryPreferencesChanged,
      callback
    )
  })
})

describe('ServerDirectoryLocationsStore', () => {
  it('retains picker display data and shares unchanged groups while publishing each read phase once', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    const listener = vi.fn()
    store.subscribe(listener)
    await flush()
    const before = store.getSnapshot().locations
    const pending = deferred()
    h.queue(Queries.ListServerDirectoryLocations, pending.promise)
    listener.mockClear()
    h.event(saved)
    expect(store.getSnapshot()).toMatchObject({
      locations: before,
      loading: true,
    })
    expect(store.getSnapshot().locations).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    const current = store.refresh()
    const same = store.refresh()
    expect(same).toBe(current)
    pending.resolve(success(structuredClone(places)))
    await current
    expect(store.getSnapshot().locations).toBe(before)
    expect(store.getSnapshot().loading).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'Saved', path: '/saved', sourcePaths: ['/saved'] },
    { name: 'Renamed', path: '/saved', sourcePaths: ['/real/saved', '/saved'] },
    { name: 'Saved', path: '/other', sourcePaths: ['/real/saved', '/saved'] },
  ])(
    'updates a changed saved-location field without replacing unrelated groups: %j',
    async (entry) => {
      const h = harness()
      const store = h.locations({ retainWhileRefreshing: true })
      store.subscribe(vi.fn())
      await flush()
      const before = store.getSnapshot().locations
      const next = { ...places, favorites: [entry] }
      h.queue(Queries.ListServerDirectoryLocations, success(next))
      await store.refresh()
      expect(store.getSnapshot().locations?.common).toBe(before?.common)
      expect(store.getSnapshot().locations?.recent).toBe(before?.recent)
      expect(store.getSnapshot().locations?.favorites).not.toBe(
        before?.favorites
      )
      expect(store.getSnapshot().locations?.favorites).toEqual(next.favorites)
    }
  )

  it('does not reuse a common group when only a semantic shortcut kind changes', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    store.subscribe(vi.fn())
    await flush()
    const before = store.getSnapshot().locations
    const next = {
      ...places,
      common: [{ kind: 'desktop', path: '/downloads' }, places.common[1]],
    }
    h.queue(Queries.ListServerDirectoryLocations, success(next))
    await store.refresh()
    expect(store.getSnapshot().locations?.common).not.toBe(before?.common)
    expect(store.getSnapshot().locations?.common).toEqual(next.common)
    expect(store.getSnapshot().locations?.favorites).toBe(before?.favorites)
  })

  it('reuses only the in-flight or applied authorization caused by this mutation’s matching event', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    store.subscribe(vi.fn())
    await flush()
    const revision = store.getRevision()
    h.bridge.invoke.mockClear()
    const pending = deferred()
    h.queue(Queries.ListServerDirectoryLocations, pending.promise)
    h.event(saved)
    await flush()
    const fallback = store.refreshAfterMutation(revision, saved)
    await flush()
    expect(h.bridge.invoke).toHaveBeenCalledTimes(1)
    pending.resolve(success(places))
    await fallback
    await store.refreshAfterMutation(revision, saved)
    expect(h.bridge.invoke).toHaveBeenCalledTimes(1)
  })

  it('starts a post-commit read when another client’s unrelated event arrived before this mutation reply', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    store.subscribe(vi.fn())
    await flush()
    const revision = store.getRevision()
    h.bridge.invoke.mockClear()
    const old = deferred()
    const fresh = deferred()
    h.queue(Queries.ListServerDirectoryLocations, old.promise, fresh.promise)
    h.event(empty)
    await flush()
    const fallback = store.refreshAfterMutation(revision, saved)
    await flush()
    expect(h.bridge.invoke).toHaveBeenCalledTimes(2)
    old.resolve(success({ common: [], favorites: [], recent: [] }))
    await flush()
    expect(store.getSnapshot().loading).toBe(true)
    fresh.resolve(success(places))
    await fallback
    expect(store.getSnapshot().locations).toEqual(places)
  })

  it('does not reuse a pending pre-commit read or a matching event seen before the action began', async () => {
    const h = harness()
    const store = h.locations()
    store.subscribe(vi.fn())
    await flush()
    h.event(saved)
    await flush()
    const revision = store.getRevision()
    h.bridge.invoke.mockClear()
    const old = deferred()
    const fresh = deferred()
    h.queue(Queries.ListServerDirectoryLocations, old.promise, fresh.promise)
    const preCommit = store.refresh()
    await flush()
    const fallback = store.refreshAfterMutation(revision, saved)
    await flush()
    expect(h.bridge.invoke).toHaveBeenCalledTimes(2)
    old.resolve(success({ common: [], favorites: [], recent: [] }))
    await preCommit
    expect(store.getSnapshot().locations).toBeNull()
    fresh.resolve(success(places))
    await fallback
    expect(store.getSnapshot().locations).toEqual(places)
  })

  it('rechecks unknown mutation outcomes without replaying the action and clears retained data on failure', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    store.subscribe(vi.fn())
    await flush()
    const revision = store.getRevision()
    h.bridge.invoke.mockClear()
    h.queue(
      Queries.ListServerDirectoryLocations,
      success({ common: places.common, favorites: [], recent: [] })
    )
    await store.refreshAfterMutation(revision)
    expect(store.getSnapshot().locations?.favorites).toEqual([])
    expect(h.bridge.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.ListServerDirectoryLocations,
      {}
    )
    h.queue(Queries.ListServerDirectoryLocations, {
      ok: false,
      error: { code: 'unavailable' },
    })
    await store.refresh()
    expect(store.getSnapshot()).toEqual({
      locations: null,
      error: 'unavailable',
      loading: false,
    })
  })

  it('stops hidden-menu location IO, cancels late reads locally, and reauthorizes on reopen', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    const unsubscribe = store.subscribe(vi.fn())
    await flush()
    const pending = deferred()
    h.queue(Queries.ListServerDirectoryLocations, pending.promise)
    const read = store.refresh()
    await flush()
    h.bridge.invoke.mockClear()
    unsubscribe()
    expect(store.getSnapshot()).toEqual({
      locations: null,
      loading: false,
      error: null,
    })
    h.event(saved)
    h.reconnect()
    pending.resolve(success(places))
    await read
    await flush()
    expect(h.bridge.invoke).not.toHaveBeenCalled()
    expect(store.getSnapshot().locations).toBeNull()
    store.subscribe(vi.fn())
    expect(store.getSnapshot().locations).toBeNull()
    await flush()
    expect(h.bridge.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.ListServerDirectoryLocations,
      {}
    )
  })

  it('avoids dispatching requests after immediate last-unsubscribe and coalesces synchronous event bursts', async () => {
    const h = harness()
    const store = h.locations()
    const unsubscribe = store.subscribe(vi.fn())
    unsubscribe()
    await flush()
    expect(h.bridge.invoke).not.toHaveBeenCalled()
    store.subscribe(vi.fn())
    await flush()
    h.bridge.invoke.mockClear()
    h.event(empty)
    h.event(saved)
    await flush()
    expect(h.bridge.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.ListServerDirectoryLocations,
      {}
    )
  })

  it('clears retained authorization immediately on reconnect', async () => {
    const h = harness()
    const store = h.locations({ retainWhileRefreshing: true })
    store.subscribe(vi.fn())
    await flush()
    const pending = deferred()
    h.queue(Queries.ListServerDirectoryLocations, pending.promise)
    h.reconnect()
    expect(store.getSnapshot()).toMatchObject({
      locations: null,
      loading: true,
    })
    pending.resolve(success(places))
    await flush()
    expect(store.getSnapshot().locations).toEqual(places)
  })

  it('clears visible locations synchronously on an event and rejects all earlier responses', async () => {
    const h = harness()
    const store = h.locations()
    store.subscribe(vi.fn())
    await flush()
    expect(store.getSnapshot().locations).toEqual(places)
    const stale = deferred()
    const fresh = deferred()
    h.queue(Queries.ListServerDirectoryLocations, stale.promise, fresh.promise)
    const oldRead = store.refresh()
    await flush()
    h.event(empty)
    expect(store.getSnapshot().locations).toBeNull()
    expect(store.getSnapshot().loading).toBe(true)
    await flush()
    stale.resolve(success(places))
    await oldRead
    expect(store.getSnapshot().locations).toBeNull()
    fresh.resolve(success({ common: places.common, favorites: [], recent: [] }))
    await flush()
    expect(store.getSnapshot().locations?.favorites).toEqual([])
    expect(store.getSnapshot().locations?.common).toHaveLength(2)
  })

  it('re-authorizes filesystem locations when the last menu consumer reopens', async () => {
    const h = harness()
    const store = h.locations()
    const unsubscribe = store.subscribe(vi.fn())
    await flush()
    unsubscribe()
    h.queue(
      Queries.ListServerDirectoryLocations,
      success({ common: [], favorites: [], recent: [] })
    )
    store.subscribe(vi.fn())
    expect(store.getSnapshot().locations).toBeNull()
    await flush()
    expect(store.getSnapshot().locations?.favorites).toEqual([])
    expect(h.bridge.invoke).toHaveBeenCalledTimes(2)
  })

  it('bounds optional locations requests, sanitizes malformed replies and supports retry', async () => {
    const h = harness()
    const store = h.locations()
    h.queue(
      Queries.ListServerDirectoryLocations,
      new Promise(() => {}),
      { ok: true, value: { ...places, secret: true } },
      success(places)
    )
    const read = store.refresh()
    await vi.advanceTimersByTimeAsync(DIRECTORY_PREFERENCES_TIMEOUT)
    await read
    expect(store.getSnapshot()).toEqual({
      locations: null,
      loading: false,
      error: 'unavailable',
    })
    await store.refresh()
    expect(store.getSnapshot().error).toBe('unavailable')
    await store.refresh()
    expect(store.getSnapshot()).toEqual({
      locations: places,
      loading: false,
      error: null,
    })
  })

  it('does not invoke a Server-only query for a disabled Desktop consumer', async () => {
    const { result } = renderHook(() => useServerDirectoryLocations(false))
    await flush()
    expect(result.current.locations).toBeNull()
    expect(transport.invoke).not.toHaveBeenCalled()
  })
})
