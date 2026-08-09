import { transport } from '@renderer/lib/transport'
import type { QueryChannel } from '@shared/protocol/queries'
import { useEffect, useRef, useState } from 'react'

const DEFAULT_INTERVAL_MS = 2000

export interface PolledCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
}

export interface UsePolledQueryOptions<T> {
  intervalMs?: number
  cache?: PolledCache<T>
  equals?: (prev: T, next: T) => boolean
  initial?: T | null
  // Controls *polling*, not the initial fetch: when false, the hook still
  // fires one fetch on mount (so the caller sees real data) but does not
  // start the polling interval. Useful for tasks in steady states where
  // the data is informative but no longer changes (paused / seeding /
  // completed). Defaults to true.
  enabled?: boolean
}

// Bounded LRU. Move-to-front on read so frequently-accessed entries survive
// past the size limit. Returns a `clear()` for test resets.
export function createLruCache<T>(
  limit: number
): PolledCache<T> & { clear: () => void } {
  const map = new Map<string, T>()
  return {
    get(key) {
      const v = map.get(key)
      if (v === undefined) return undefined
      map.delete(key)
      map.set(key, v)
      return v
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      if (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
  }
}

// Polls a query channel every `intervalMs` while `id` is non-null. Only
// `channel`/`id`/`intervalMs` drive (re)subscription; `params`, `cache`,
// `equals`, and `initial` are read from a ref so callers can pass fresh
// inline objects without tearing the poll down each render. Contract:
// `params` must encode the data identified by `id`.
export function usePolledQuery<T>(
  channel: QueryChannel,
  id: string | null,
  params: object | null,
  options: UsePolledQueryOptions<T> = {}
): T | null {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    cache,
    equals,
    initial = null,
    enabled = true,
  } = options

  const latest = useRef({ params, cache, equals, initial })
  latest.current = { params, cache, equals, initial }

  const [value, setValue] = useState<T | null>(() => {
    if (id !== null && cache) {
      const cached = cache.get(id)
      if (cached !== undefined) return cached
    }
    return initial
  })

  useEffect(() => {
    const {
      params: initialParams,
      cache: initialCache,
      initial: initialValue,
    } = latest.current
    if (id === null || initialParams === null) {
      setValue(initialValue ?? null)
      return
    }
    const activeId = id
    if (initialCache) {
      setValue(initialCache.get(activeId) ?? initialValue ?? null)
    }
    let cancelled = false
    const load = async () => {
      const {
        params: nextParams,
        cache: nextCache,
        equals: nextEquals,
      } = latest.current
      if (nextParams === null) return
      try {
        const data = (await transport.invoke(channel, nextParams)) as T
        nextCache?.set(activeId, data)
        if (!cancelled) {
          setValue((prev) =>
            prev !== null && nextEquals?.(prev, data) ? prev : data
          )
        }
      } catch {
        /* retry next tick */
      }
    }
    load()
    if (!enabled) {
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [channel, id, intervalMs, enabled])

  return value
}
