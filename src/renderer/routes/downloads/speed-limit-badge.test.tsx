import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { toast } from '@renderer/components/ui/toast'
import type { SpeedLimitStateView } from '@renderer/hooks/use-speed-limit-state'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeedLimitBadge } from './speed-limit-badge'

let state: SpeedLimitStateView
let user: ReturnType<typeof userEvent.setup>
vi.mock('@renderer/hooks/use-speed-limit-state', () => ({
  useSpeedLimitState: () => state,
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: vi.fn() } }))

function setup() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<SpeedLimitBadge />} />
        <Route
          path="/settings/downloads"
          element={<h1>Download settings</h1>}
        />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  user = userEvent.setup()
  vi.clearAllMocks()
  vi.mocked(transport.invoke).mockResolvedValue(undefined)
  state = {
    turtle: 'off',
    effective: { upload: 0, download: 800_000 },
    activeReason: 'base',
  }
})

describe('SpeedLimitBadge', () => {
  it.each([
    ['off', 'Standard', 'rabbit'],
    ['on', 'Low speed', 'turtle'],
    ['auto', 'Automatic', 'squirrel'],
  ] as const)(
    'shows the %s mode with its existing dashboard glyph',
    async (mode, label, icon) => {
      state.turtle = mode
      setup()
      const button = screen.getByRole('button', {
        name: `Speed mode: ${label}`,
      })
      expect(button.querySelector(`.lucide-${icon}`)).toBeInTheDocument()
      await user.click(button)
      const radios = await screen.findAllByRole('menuitemradio')
      expect(radios).toHaveLength(3)
      expect(radios[['off', 'on', 'auto'].indexOf(mode)]).toHaveAttribute(
        'aria-checked',
        'true'
      )
      expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'top')
    }
  )

  it('shows effective limits without calling standard mode unlimited', async () => {
    const user = userEvent.setup()
    setup()
    await user.hover(
      screen.getByRole('button', { name: 'Speed mode: Standard' })
    )
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Speed mode: Standard')
    expect(tooltip).toHaveTextContent('Upload limit: Unlimited')
    expect(tooltip).toHaveTextContent('Download limit: 800 KB/s')
    await user.click(
      screen.getByRole('button', { name: 'Speed mode: Standard' })
    )
    await waitFor(() =>
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    )
  })

  it('saves only the chosen mode and prevents another change while saving', async () => {
    let finish!: () => void
    vi.mocked(transport.invoke).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    setup()
    const button = screen.getByRole('button', { name: 'Speed mode: Standard' })
    await user.click(button)
    fireEvent.click(
      await screen.findByRole('menuitemradio', { name: 'Low-speed mode' })
    )
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Commands.UpdateSettings,
      { speedLimit: { turtle: 'on' } }
    )
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(button).not.toBeDisabled()
    // The confirmed controller state, rather than an optimistic guess, owns the label.
    expect(button).toHaveTextContent('Standard')
  })

  it('keeps the confirmed mode on failure and allows retry', async () => {
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('save failed'))
    setup()
    const button = screen.getByRole('button', { name: 'Speed mode: Standard' })
    await user.click(button)
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'Automatic mode' })
    )
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        type: 'error',
        title: 'Couldn’t change the speed mode. Try again.',
      })
    )
    expect(button).not.toBeDisabled()
    expect(button).toHaveTextContent('Standard')
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
    await user.click(button)
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'Automatic mode' })
    )
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(2))
  })

  it('keeps automatic mode visible when no rule is active and opens existing settings', async () => {
    state = {
      turtle: 'auto',
      activeReason: 'none',
      effective: { upload: 0, download: 0 },
    }
    setup()
    const button = screen.getByRole('button', { name: 'Speed mode: Automatic' })
    expect(button).toHaveAttribute('data-reduced', 'false')
    await user.click(button)
    await user.click(
      await screen.findByRole('menuitem', { name: 'Speed limit settings' })
    )
    expect(
      screen.getByRole('heading', { name: 'Download settings' })
    ).toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalled()
  })
})
