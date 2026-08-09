import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCompactHeader } from './use-compact-header'

beforeEach(() => {
  // jsdom gap — SidebarProvider reads localStorage for persisted state
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  })
  // jsdom gap — SidebarProvider's useIsMobile reads matchMedia
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function collapsedWrapper({ children }: { children: ReactNode }) {
  return <SidebarProvider defaultOpen={false}>{children}</SidebarProvider>
}

function expandedWrapper({ children }: { children: ReactNode }) {
  return <SidebarProvider defaultOpen>{children}</SidebarProvider>
}

describe('useCompactHeader', () => {
  it('degrades to false outside a SidebarProvider', () => {
    const { result } = renderHook(() => useCompactHeader())
    expect(result.current).toBe(false)
  })

  it('is true when the sidebar is collapsed', () => {
    const { result } = renderHook(() => useCompactHeader(), {
      wrapper: collapsedWrapper,
    })
    expect(result.current).toBe(true)
  })

  it('is false when the sidebar is expanded on a wide viewport', () => {
    const { result } = renderHook(() => useCompactHeader(), {
      wrapper: expandedWrapper,
    })
    expect(result.current).toBe(false)
  })

  it('is true on a mobile viewport even when expanded', () => {
    vi.stubGlobal('innerWidth', 500) // below MOBILE_BREAKPOINT (768)
    const { result } = renderHook(() => useCompactHeader(), {
      wrapper: expandedWrapper,
    })
    expect(result.current).toBe(true)
  })
})
