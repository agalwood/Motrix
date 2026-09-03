import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyInitialRendererTheme,
  resolveInitialRendererTheme,
} from './initial-theme'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
  document.documentElement.classList.remove('light', 'dark')
  document.documentElement.style.colorScheme = ''
  document.getElementById('motrix-theme-bootstrap')?.remove()
})

describe('resolveInitialRendererTheme', () => {
  it.each([
    [true, 'dark'],
    [false, 'light'],
  ] as const)(
    'uses Electron nativeTheme propagation when prefersDark=%s',
    (prefersDark, expected) => {
      expect(
        resolveInitialRendererTheme({
          target: 'electron',
          storedTheme: expected === 'dark' ? 'light' : 'dark',
          prefersDark,
        })
      ).toBe(expected)
    }
  )

  it.each(['light', 'dark'] as const)(
    'honors the web renderer stored theme %s',
    (storedTheme) => {
      expect(
        resolveInitialRendererTheme({
          target: 'web',
          storedTheme,
          prefersDark: storedTheme === 'light',
        })
      ).toBe(storedTheme)
    }
  )

  it('falls back to the system preference for web system mode', () => {
    expect(
      resolveInitialRendererTheme({
        target: 'web',
        storedTheme: 'system',
        prefersDark: true,
      })
    ).toBe('dark')
  })

  it('applies the pre-React class and removes the temporary bootstrap style', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    )
    const bootstrapStyle = document.createElement('style')
    bootstrapStyle.id = 'motrix-theme-bootstrap'
    document.head.append(bootstrapStyle)

    expect(applyInitialRendererTheme('electron')).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement).not.toHaveClass('light')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.getElementById('motrix-theme-bootstrap')).toBeNull()
  })
})
