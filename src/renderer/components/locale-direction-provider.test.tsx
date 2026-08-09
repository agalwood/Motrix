import '@testing-library/jest-dom/vitest'
import { useDirection } from '@renderer/components/ui/direction'
import { i18n } from '@renderer/lib/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleDirectionProvider } from './locale-direction-provider'

const getLocaleDirection = vi.hoisted(() =>
  vi.fn((locale: string) => (locale === 'zh-CN' ? 'rtl' : 'ltr'))
)

vi.mock('@shared/constants/locales', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@shared/constants/locales')>()
  return { ...actual, getLocaleDirection }
})

function DirectionProbe() {
  const direction = useDirection()
  return <output data-testid="direction">{direction}</output>
}

describe('LocaleDirectionProvider', () => {
  beforeEach(async () => {
    getLocaleDirection.mockClear()
    await i18n.changeLanguage('en-US')
  })

  it('updates Base UI direction when a future RTL catalog locale activates', async () => {
    render(
      <LocaleDirectionProvider>
        <DirectionProbe />
      </LocaleDirectionProvider>
    )
    expect(screen.getByTestId('direction')).toHaveTextContent('ltr')

    await act(() => i18n.changeLanguage('zh-CN'))

    await waitFor(() =>
      expect(screen.getByTestId('direction')).toHaveTextContent('rtl')
    )
    expect(getLocaleDirection).toHaveBeenLastCalledWith('zh-CN')
  })
})
