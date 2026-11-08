import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLegacyImportSidebarStore } from './sidebar-preference'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  })
})

describe('legacy import sidebar preference', () => {
  it('restores an explicit dismissal when the app starts again', () => {
    const store = createLegacyImportSidebarStore()
    expect(store.getState().dismissed).toBe(false)
    store.getState().dismiss()
    expect(store.getState().dismissed).toBe(true)
    expect(createLegacyImportSidebarStore().getState().dismissed).toBe(true)
  })

  it('keeps dismissal usable for this session when storage is unavailable', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    const store = createLegacyImportSidebarStore()
    expect(store.getState().dismissed).toBe(false)
    store.getState().dismiss()
    expect(store.getState().dismissed).toBe(true)
  })
})
