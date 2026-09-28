import '@testing-library/jest-dom/vitest'
import { useDirection } from '@renderer/components/ui/direction'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocaleDirectionProvider } from './locale-direction-provider'

function DirectionProbe() {
  const direction = useDirection()
  return <output data-testid="direction">{direction}</output>
}

describe('LocaleDirectionProvider', () => {
  beforeEach(async () => {
    await applyRendererLocale('en-US')
  })

  it.each(['ar', 'fa'])(
    'synchronizes Base UI and document direction for %s and back to English',
    async (locale) => {
      render(
        <LocaleDirectionProvider>
          <DirectionProbe />
        </LocaleDirectionProvider>
      )
      expect(screen.getByTestId('direction')).toHaveTextContent('ltr')

      await act(() => applyRendererLocale(locale))

      await waitFor(() =>
        expect(screen.getByTestId('direction')).toHaveTextContent('rtl')
      )
      expect(document.documentElement).toHaveAttribute('dir', 'rtl')
      await act(() => applyRendererLocale('en-US'))
      await waitFor(() =>
        expect(screen.getByTestId('direction')).toHaveTextContent('ltr')
      )
      expect(document.documentElement).toHaveAttribute('dir', 'ltr')
    }
  )
})
