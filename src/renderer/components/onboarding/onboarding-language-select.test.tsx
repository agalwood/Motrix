import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { SUPPORTED_LOCALES } from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingLanguageSelect } from './onboarding-language-select'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {}
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {}
  }
})

describe('OnboardingLanguageSelect', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockResolvedValue(undefined)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    await i18n.changeLanguage('en-US')
  })

  it('pins Follow system first and applies the host-resolved locale after saving', async () => {
    let saved = false
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Commands.SetDisclaimerLanguage) {
        saved = true
        return { ok: true }
      }
      if (channel === Queries.GetDisclaimerState)
        return {
          language: saved ? 'system' : 'en-US',
          resolvedLanguage: saved ? 'fr' : 'en-US',
        }
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<OnboardingLanguageSelect />)
    const select = screen.getByTestId('onboarding-language')
    await user.click(select)
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Follow system',
      ...SUPPORTED_LOCALES.map(({ nativeName }) => nativeName),
    ])
    await user.click(options[0]!)
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('fr'))
    expect(select).toHaveTextContent('Suivre le système')
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.SetDisclaimerLanguage,
      'system'
    )
  })

  it('shows a saved system preference on reopening', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      language: 'system',
      resolvedLanguage: 'fr',
    })
    render(<OnboardingLanguageSelect />)
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-language')).toHaveTextContent(
        'Follow system'
      )
    )
  })

  it.each([
    ['简体中文', 'zh-CN'],
    ['Français', 'fr'],
  ])(
    'switches to %s immediately and persists only that preference',
    async (name, locale) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(<OnboardingLanguageSelect />)

      const trigger = screen.getByTestId('onboarding-language')
      expect(trigger).toHaveClass('min-w-28', 'max-w-64')
      expect(trigger).not.toHaveClass('w-28')

      await user.click(trigger)
      await user.click(await screen.findByRole('option', { name }))

      await waitFor(() => expect(i18n.resolvedLanguage).toBe(locale))
      expect(document.documentElement).toHaveAttribute('lang', locale)
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SetDisclaimerLanguage,
        locale
      )
    }
  )
})
