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
  args: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DirectoryPreferenceRequestError(true)),
      DIRECTORY_PREFERENCES_TIMEOUT
    )
    Promise.resolve()
      .then(() => bridge.invoke(channel, args))
      .then((value) => resolve(schema.parse(value)))
      .catch(() => reject(new DirectoryPreferenceRequestError()))
      .finally(() => clearTimeout(timer))
  })
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
    this.state = { ...this.state, ...patch }
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
    action: MutateDirectoryPreferencesRequest
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

/** Optional authorized locations have a deadline and epoch separate from browsing. */
export class ServerDirectoryLocationsStore {
  private state: LocationsState = EMPTY_LOCATIONS
  private listeners = new Set<() => void>()
  private started = false
  private disposed = false
  private epoch = 0
  private disconnect?: () => void

  constructor(private readonly bridge: DirectoryTransport) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    const firstSubscriber = this.listeners.size === 0
    this.listeners.add(listener)
    if (this.start()) void this.refresh()
    else if (firstSubscriber) this.changed()
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<LocationsState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private changed = () => {
    // Invalidate visible saved aliases synchronously as well as older requests.
    this.epoch++
    this.update({ locations: null })
    void this.refresh()
  }
  private start() {
    if (this.started || this.disposed) return false
    this.started = true
    this.bridge.on?.(Events.DirectoryPreferencesChanged, this.changed)
    this.disconnect = this.bridge.onConnectionChange?.(({ state }) => {
      if (state === 'connected') this.changed()
    })
    return true
  }
  refresh = async (): Promise<void> => {
    if (this.disposed) return
    this.start()
    const epoch = ++this.epoch
    this.update({ loading: true, error: null })
    try {
      const result = await request(
        this.bridge,
        Queries.ListServerDirectoryLocations,
        ListServerDirectoryLocationsResultSchema,
        {}
      )
      if (this.disposed || epoch !== this.epoch) return
      this.update(
        result.ok
          ? { locations: result.value, error: null }
          : { locations: null, error: result.error.code }
      )
    } catch {
      if (!this.disposed && epoch === this.epoch)
        this.update({ locations: null, error: 'unavailable' })
    } finally {
      if (!this.disposed && epoch === this.epoch)
        this.update({ loading: false })
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
