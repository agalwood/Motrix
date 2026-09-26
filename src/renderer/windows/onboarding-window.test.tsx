import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingWindow } from './onboarding-window'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue({ language: 'zh-CN' }),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

describe('OnboardingWindow', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await applyRendererLocale('zh-CN')
  })

  it('renders the pre-bootstrapped legal gate while reading the saved language preference', async () => {
    let resolvePreference!: (state: {
      language: 'system'
      resolvedLanguage: 'zh-CN'
    }) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreference = resolve
      })
    )
    render(<OnboardingWindow />)

    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetDisclaimerState
    )
    expect(screen.getByTestId('disclaimer-panel')).toBeVisible()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '语言' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '使用声明' })).toBeVisible()
    const surface = document.querySelector(
      '[data-slot="onboarding-surface"]'
    ) as HTMLElement
    expect(surface).toHaveClass(
      'bg-[#f7f7f8]',
      'dark:bg-[#161617]',
      'text-[#1d1d1f]',
      'dark:text-foreground'
    )
    expect(surface.style.colorScheme).toBe('')

    await act(async () => {
      resolvePreference({ language: 'system', resolvedLanguage: 'zh-CN' })
    })
    expect(screen.getByRole('combobox', { name: '语言' })).toHaveTextContent(
      '跟随系统'
    )
    expect(screen.getByRole('heading', { name: '使用声明' })).toBeVisible()
  })
})
