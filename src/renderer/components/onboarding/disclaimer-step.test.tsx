import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DisclaimerStep } from './disclaimer-step'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

describe('DisclaimerStep', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(transport.invoke).mockResolvedValue(undefined)
    await i18n.changeLanguage('en-US')
  })

  it('persists acceptance and blocks duplicate actions while saving', async () => {
    let resolveAcceptance!: () => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAcceptance = resolve
      })
    )
    render(<DisclaimerStep />)

    const agree = screen.getByTestId('disclaimer-agree')
    const quit = screen.getByTestId('disclaimer-quit')
    fireEvent.click(agree)
    await waitFor(() => {
      expect(agree).toBeDisabled()
      expect(quit).toBeDisabled()
    })

    fireEvent.click(agree)
    fireEvent.click(quit)
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.AcceptDisclaimer)

    resolveAcceptance()
    await waitFor(() => expect(agree).not.toBeDisabled())
  })

  it('declines the disclaimer through its dedicated command', () => {
    render(<DisclaimerStep />)
    fireEvent.click(screen.getByTestId('disclaimer-quit'))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.DeclineDisclaimer)
  })

  it('shows an inline persistence error and supports retry', async () => {
    const invoke = vi.mocked(transport.invoke)
    invoke.mockRejectedValueOnce(new Error('disk full'))
    render(<DisclaimerStep />)

    fireEvent.click(screen.getByTestId('disclaimer-agree'))
    expect(await screen.findByTestId('disclaimer-error')).toBeVisible()
    expect(screen.getByTestId('disclaimer-agree')).toHaveTextContent('Retry')

    invoke.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByTestId('disclaimer-agree'))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })

  it('renders professional copy through black Blur Highlights', () => {
    render(<DisclaimerStep />)

    expect(screen.getByRole('heading', { name: 'Usage Notice' })).toBeVisible()
    const highlightRoot = document.querySelector(
      '[data-slot="blur-highlight"]'
    ) as HTMLElement
    const highlightedBits = [
      ...document.querySelectorAll('[data-slot="blur-highlight-bit"]'),
    ]
    expect(highlightRoot.textContent).toBe(i18n.t('onboarding.disclaimer.body'))
    expect(highlightRoot.style.getPropertyValue('--blur-highlight-color')).toBe(
      '#171717'
    )
    expect(highlightedBits.map((bit) => bit.textContent)).toEqual([
      'provides download management only',
      'legally authorized',
      'You are responsible',
    ])
  })

  it('renders the matching Chinese copy and highlighted phrases', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<DisclaimerStep />)

    expect(screen.getByRole('heading', { name: '使用声明' })).toBeVisible()
    expect(
      [...document.querySelectorAll('[data-slot="blur-highlight-bit"]')].map(
        (bit) => bit.textContent
      )
    ).toEqual(['仅提供下载管理功能', '已获得合法授权', '责任由您自行承担'])
  })

  it('contains no app icon or progress UI and uses the primary action', () => {
    const { container } = render(<DisclaimerStep />)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Agree & Continue' })
    ).toHaveClass('w-full', 'bg-primary', 'text-primary-foreground')
  })
})
