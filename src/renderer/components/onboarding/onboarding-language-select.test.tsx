import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
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
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    await i18n.changeLanguage('en-US')
  })

  it('switches language immediately and persists only that preference', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<OnboardingLanguageSelect />)

    const trigger = screen.getByTestId('onboarding-language')
    expect(trigger).toHaveClass('min-w-28', 'max-w-64')
    expect(trigger).not.toHaveClass('w-28')

    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: '简体中文' }))

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN')
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.SetDisclaimerLanguage,
      'zh-CN'
    )
  })
})
