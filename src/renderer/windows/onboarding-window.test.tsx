import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { render, screen } from '@testing-library/react'
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

  it('renders the pre-bootstrapped legal gate without another locale query', () => {
    render(<OnboardingWindow />)

    expect(transport.invoke).not.toHaveBeenCalled()
    expect(screen.getByTestId('disclaimer-panel')).toBeVisible()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('onboarding-language').parentElement).toHaveClass(
      'pt-3.5'
    )
    expect(screen.getByRole('heading', { name: '使用声明' })).toBeVisible()
  })
})
