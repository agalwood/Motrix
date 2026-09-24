import { transport } from '@renderer/lib/transport'
import type { Transport } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type DirectoryPreferences,
  type DirectoryPreferencesErrorCode,
  DirectoryPreferencesResultSchema,
  DirectoryPreferencesSchema,
  type MutateDirectoryPreferencesRequest,
  MutateDirectoryPreferencesRequestSchema,
} from '@shared/schemas/directory-preferences'
import {
  type DirectoryErrorCode,
  ListServerDirectoryLocationsResultSchema,
  type ServerDirectoryLocations,
} from '@shared/schemas/server-directory'
import { useSyncExternalStore } from 'react'
import type { z } from 'zod'

export const DIRECTORY_PREFERENCES_TIMEOUT = 20_000
type DirectoryTransport = Pick<Transport, 'invoke'> &
  Partial<Pick<Transport, 'on' | 'off' | 'onConnectionChange'>>

class DirectoryPreferenceRequestError extends Error {
  constructor(readonly timeout = false) {
    super('Directory preferences request unavailable')
  }
}

function request<T>(
  bridge: DirectoryTransport,
  channel: Parameters<Transport['invoke']>[0],
  schema: z.ZodType<T>,
  args: unknown,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: T | undefined, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(undefined, new DirectoryPreferenceRequestError())
    const timer = setTimeout(
      () => finish(undefined, new DirectoryPreferenceRequestError(true)),
      DIRECTORY_PREFERENCES_TIMEOUT
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw new DirectoryPreferenceRequestError()
        return bridge.invoke(channel, args)
      })
      .then((value) => {
        if (!settled) finish(schema.parse(value))
      })
      .catch(() => finish(undefined, new DirectoryPreferenceRequestError()))
  })
}

function sharePaths(previous: string[], next: string[]): string[] {
  return previous.length === next.length &&
    previous.every((value, index) => value === next[index])
    ? previous
    : next
}

function sharePreferences(
  previous: DirectoryPreferences,
  next: DirectoryPreferences
): DirectoryPreferences {
  const favorites = sharePaths(previous.favorites, next.favorites)
  const recent = sharePaths(previous.recent, next.recent)
  return favorites === previous.favorites && recent === previous.recent
    ? previous
    : { favorites, recent }
}

function shareLocations(
  previous: ServerDirectoryLocations | null,
  next: ServerDirectoryLocations
): ServerDirectoryLocations {
  if (!previous) return next
  const common =
    previous.common.length === next.common.length &&
    previous.common.every(
      (entry, index) =>
        entry.kind === next.common[index].kind &&
        entry.path === next.common[index].path
    )
      ? previous.common
      : next.common
  const shareEntries = (
    before: ServerDirectoryLocations['favorites'],
    after: ServerDirectoryLocations['favorites']
  ) => {
    const entries = after.map((entry, index) => {
      const old = before[index]
      return old &&
        old.name === entry.name &&
        old.path === entry.path &&
        sharePaths(old.sourcePaths, entry.sourcePaths) === old.sourcePaths
        ? old
        : entry
    })
    return before.length === entries.length &&
      entries.every((entry, index) => entry === before[index])
      ? before
      : entries
  }
  const favorites = shareEntries(previous.favorites, next.favorites)
  const recent = shareEntries(previous.recent, next.recent)
  return common === previous.common &&
    favorites === previous.favorites &&
    recent === previous.recent
    ? previous
    : { common, favorites, recent }
}

type PreferencesState = {
  preferences: DirectoryPreferences
  loading: boolean
  error: DirectoryPreferencesErrorCode | null
}

/** Host-owned data: this mirror never writes whole lists or uses browser storage. */
export class DirectoryPreferencesStore {
  private state: PreferencesState = {
    preferences: { favorites: [], recent: [] },
    loading: true,
    error: null,
  }
  private listeners = new Set<() => void>()
  private started = false
  private disposed = false
  private epoch = 0
  private reading = false
  private pendingMutations = 0
  private disconnect?: () => void

  constructor(private readonly bridge: DirectoryTransport) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    const firstSubscriber = this.listeners.size === 0
    this.listeners.add(listener)
    if (this.start() || firstSubscriber) void this.refresh()
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<PreferencesState>) {
    if (this.disposed) return
    const next = {
      ...this.state,
      ...patch,
      preferences: patch.preferences
        ? sharePreferences(this.state.preferences, patch.preferences)
        : this.state.preferences,
    }
    if (
      next.preferences === this.state.preferences &&
      next.loading === this.state.loading &&
      next.error === this.state.error
    )
      return
    this.state = next
    for (const listener of this.listeners) listener()
  }
  private changed = (payload: unknown) => {
    this.epoch++
    this.reading = false
    const parsed = DirectoryPreferencesSchema.safeParse(payload)
    if (parsed.success) {
      this.update({
        preferences: parsed.data,
        error: null,
        loading: this.pendingMutations > 0,
      })
    } else void this.refresh()
  }
  private start() {
    if (this.started || this.disposed) return false
    this.started = true
    this.bridge.on?.(Events.DirectoryPreferencesChanged, this.changed)
    this.disconnect = this.bridge.onConnectionChange?.(({ state }) => {
      if (state === 'connected') void this.refresh()
    })
    return true
  }
  refresh = async (preserveError = false): Promise<void> => {
    if (this.disposed) return
    this.start()
    const epoch = ++this.epoch
    this.reading = true
    this.update({ loading: true, ...(preserveError ? {} : { error: null }) })
    try {
      const result = await request(
        this.bridge,
        Queries.GetDirectoryPreferences,
        DirectoryPreferencesResultSchema,
        {}
      )
      if (this.disposed || epoch !== this.epoch) return
      if (result.ok)
        this.update({
          preferences: result.value,
          ...(preserveError ? {} : { error: null }),
        })
      else this.update({ error: result.error.code })
    } catch {
      if (!this.disposed && epoch === this.epoch)
        this.update({ error: 'unavailable' })
    } finally {
      if (!this.disposed && epoch === this.epoch) {
        this.reading = false
        this.update({ loading: this.pendingMutations > 0 })
      }
    }
  }
  mutate = async (
    action: MutateDirectoryPreferencesRequest,
    onCommitted?: (preferences: DirectoryPreferences) => void
  ): Promise<boolean> => {
    if (this.disposed) return false
    const parsed = MutateDirectoryPreferencesRequestSchema.safeParse(action)
    if (!parsed.success) {
      this.update({
        error: 'invalidPath',
        loading: this.reading || this.pendingMutations > 0,
      })
      return false
    }
    this.start()
    const epoch = ++this.epoch
    this.reading = false
    this.pendingMutations++
    this.update({ loading: true, error: null })
    try {
      const result = await request(
        this.bridge,
        Commands.MutateDirectoryPreferences,
        DirectoryPreferencesResultSchema,
        parsed.data
      )
      if (this.disposed) return false
      if (epoch === this.epoch) {
        this.update(
          result.ok
            ? { preferences: result.value, error: null }
            : { error: result.error.code }
        )
      }
      if (result.ok) onCommitted?.(result.value)
      return result.ok
    } catch {
      if (this.disposed) return false
      if (epoch === this.epoch) this.update({ error: 'unavailable' })
      // A lost reply may follow a committed write. Read the host again without
      // replaying the action or making an optimistic local change.
      void this.refresh(true)
      return false
    } finally {
      this.pendingMutations--
      this.update({ loading: this.reading || this.pendingMutations > 0 })
    }
  }
  dispose() {
    this.disposed = true
    this.epoch++
    this.bridge.off?.(Events.DirectoryPreferencesChanged, this.changed)
    this.disconnect?.()
    this.listeners.clear()
  }
}

type LocationsState = {
  locations: ServerDirectoryLocations | null
  loading: boolean
  error: DirectoryErrorCode | null
}
const EMPTY_LOCATIONS: LocationsState = {
  locations: null,
  loading: false,
  error: null,
}

export interface ServerDirectoryLocationsOptions {
  /** Display only: consumers must disable saved-location actions while loading. */
  retainWhileRefreshing?: boolean
}

type LocationsEvent = { revision: number; fingerprint: string }
type LocationsRequest = {
  epoch: number
  event: LocationsEvent | undefined
  controller: AbortController
  promise: Promise<void>
}

/** Optional authorized locations have a deadline and epoch separate from browsing. */
export class ServerDirectoryLocationsStore {
  private state: LocationsState = EMPTY_LOCATIONS
  private listeners = new Set<() => void>()
  private started = false
  private disposed = false
  private epoch = 0
  private revision = 0
  private latestEvent?: LocationsEvent
  private pending?: LocationsRequest
  private applied?: { epoch: number; event: LocationsEvent | undefined }
  private disconnect?: () => void

  constructor(
    private readonly bridge: DirectoryTransport,
    private readonly options: ServerDirectoryLocationsOptions = {}
  ) {}

  getSnapshot = () => this.state
  getRevision = () => this.revision
  subscribe = (listener: () => void) => {
    const firstSubscriber = this.listeners.size === 0
    this.listeners.add(listener)
    if (firstSubscriber) {
      this.start()
      // Reopening requires a fresh authorization, even with a retained cache.
      this.invalidate()
      void this.startRead(true)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }
  private update(patch: Partial<LocationsState>) {
    if (this.disposed) return
    const next = {
      ...this.state,
      ...patch,
      locations: patch.locations
        ? shareLocations(this.state.locations, patch.locations)
        : patch.locations === null
          ? null
          : this.state.locations,
    }
    if (
      next.locations === this.state.locations &&
      next.loading === this.state.loading &&
      next.error === this.state.error
    )
      return
    this.state = next
    for (const listener of this.listeners) listener()
  }
  private invalidate() {
    this.revision++
    this.epoch++
    this.pending?.controller.abort()
    this.pending = undefined
    this.applied = undefined
  }
  private changed = (payload: unknown) => {
    this.invalidate()
    const parsed = DirectoryPreferencesSchema.safeParse(payload)
    this.latestEvent = parsed.success
      ? { revision: this.revision, fingerprint: JSON.stringify(parsed.data) }
      : undefined
    if (this.listeners.size > 0) void this.refresh()
    else this.update({ locations: null, loading: false, error: null })
  }
  private start() {
    if (this.started || this.disposed) return
    this.started = true
    this.bridge.on?.(Events.DirectoryPreferencesChanged, this.changed)
    this.disconnect = this.bridge.onConnectionChange?.(({ state }) => {
      if (state !== 'connected') return
      this.invalidate()
      this.latestEvent = undefined
      if (this.listeners.size > 0) void this.startRead(true)
      else this.update({ locations: null, loading: false, error: null })
    })
  }
  private stop() {
    this.started = false
    this.bridge.off?.(Events.DirectoryPreferencesChanged, this.changed)
    this.disconnect?.()
    this.disconnect = undefined
    this.invalidate()
    this.latestEvent = undefined
    this.update({ locations: null, loading: false, error: null })
  }
  /** Only an authorization read caused by this committed snapshot replaces the fallback. */
  refreshAfterMutation = (
    since: number,
    committed?: DirectoryPreferences
  ): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    const event = this.latestEvent
    const read = this.pending ?? this.applied
    if (
      committed &&
      event &&
      event.revision > since &&
      event.fingerprint === JSON.stringify(committed) &&
      read?.epoch === this.epoch &&
      read.event === event
    )
      return this.pending?.promise ?? Promise.resolve()
    // A different client's event or a pre-commit read cannot certify this action.
    // Unknown mutation outcomes also need an authoritative read without replay.
    this.invalidate()
    return this.refresh()
  }
  refresh = (): Promise<void> =>
    this.startRead(!this.options.retainWhileRefreshing)
  private startRead(clear: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending?.epoch === this.epoch) return this.pending.promise
    this.start()
    const pending: LocationsRequest = {
      epoch: ++this.epoch,
      event: this.latestEvent,
      controller: new AbortController(),
      promise: Promise.resolve(),
    }
    this.pending = pending
    this.update({
      loading: true,
      error: null,
      ...(clear ? { locations: null } : {}),
    })
    pending.promise = this.read(pending)
    return pending.promise
  }
  private async read(pending: LocationsRequest): Promise<void> {
    try {
      const result = await request(
        this.bridge,
        Queries.ListServerDirectoryLocations,
        ListServerDirectoryLocationsResultSchema,
        {},
        pending.controller.signal
      )
      if (this.disposed || pending.epoch !== this.epoch) return
      this.pending = undefined
      this.applied = result.ok
        ? { epoch: pending.epoch, event: pending.event }
        : undefined
      this.update(
        result.ok
          ? { locations: result.value, error: null, loading: false }
          : { locations: null, error: result.error.code, loading: false }
      )
    } catch {
      if (!this.disposed && pending.epoch === this.epoch) {
        this.pending = undefined
        this.applied = undefined
        this.update({ locations: null, error: 'unavailable', loading: false })
      }
    }
  }
  dispose() {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }
}

export const directoryPreferences = new DirectoryPreferencesStore(transport)
export const serverDirectoryLocations = new ServerDirectoryLocationsStore(
  transport
)

export function useDirectoryPreferences() {
  const snapshot = useSyncExternalStore(
    directoryPreferences.subscribe,
    directoryPreferences.getSnapshot
  )
  return {
    ...snapshot,
    refresh: directoryPreferences.refresh,
    mutate: directoryPreferences.mutate,
  }
}

const subscribeDisabled = () => () => {}
const getDisabledLocations = () => EMPTY_LOCATIONS
export function useServerDirectoryLocations(enabled = true) {
  const snapshot = useSyncExternalStore(
    enabled ? serverDirectoryLocations.subscribe : subscribeDisabled,
    enabled ? serverDirectoryLocations.getSnapshot : getDisabledLocations
  )
  return { ...snapshot, refresh: serverDirectoryLocations.refresh }
}

export async function recordRecentDirectory(path: string): Promise<void> {
  await directoryPreferences.mutate({ action: 'recordRecent', path })
}
