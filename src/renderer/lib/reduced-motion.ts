import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const listeners = new Set<() => void>()
let appReduceMotion = DEFAULT_APP_SETTINGS.reduceMotion
let subscribedQuery: MediaQueryList | undefined

function systemMotionQuery(): MediaQueryList | undefined {
  return typeof window === 'undefined'
    ? undefined
    : window.matchMedia?.(REDUCED_MOTION_QUERY)
}

export function getReducedMotion(): boolean {
  return appReduceMotion || getSystemReducedMotion()
}

function getSystemReducedMotion(): boolean {
  return (subscribedQuery ?? systemMotionQuery())?.matches === true
}

function notify(): void {
  for (const listener of listeners) listener()
}

// This is a renderer cache of the host setting, never a persistence boundary.
export function setAppReduceMotion(value: boolean): void {
  if (appReduceMotion === value) return
  appReduceMotion = value
  notify()
}

export function subscribeReducedMotion(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    subscribedQuery = systemMotionQuery()
    subscribedQuery?.addEventListener('change', notify)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      subscribedQuery?.removeEventListener('change', notify)
      subscribedQuery = undefined
    }
  }
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotion)
}

export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getSystemReducedMotion)
}
