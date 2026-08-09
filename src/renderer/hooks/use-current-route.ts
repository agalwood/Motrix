import { useLocation } from 'react-router'

/**
 * Current route pathname for MenuContext sync.
 * Thin wrapper — the raw useLocation().pathname is what we want.
 */
export function useCurrentRoute(): string {
  return useLocation().pathname
}
