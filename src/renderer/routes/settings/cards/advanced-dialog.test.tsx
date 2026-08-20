import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { transport } from '@renderer/lib/transport'
import { AdvancedDialog } from './advanced-dialog'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SETTINGS_FIXTURE = {
  engine: {
    rpcPort: 16800,
    rpcSecret: 'abc12345',
    sqlite3Persistence: true,
    sqlite3DbPath: '',
    sqlite3HistoryLimit: -1,
  },
}

describe('<AdvancedDialog>', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === Queries.GetSettings) return SETTINGS_FIXTURE
      return { saved: true, requiresRestart: false, changedRestartKeys: [] }
    })
  })

  it('hydrates from GetSettings on mount', async () => {
    render(
      <AdvancedDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.advanced.title"
        descKey="settings.cards.advanced.desc"
      />
    )
    await waitFor(() => {
      expect(screen.getByDisplayValue('16800')).toBeInTheDocument()
    })
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
  })

  it('aborts submit when no fields are dirty', async () => {
    const onClose = vi.fn()
    render(
      <AdvancedDialog
        open
        onClose={onClose}
        labelKey="settings.cards.advanced.title"
        descKey="settings.cards.advanced.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('16800'))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('saves a restart-required field without a pre-save confirmation', async () => {
    const onClose = vi.fn()
    render(
      <AdvancedDialog
        open
        onClose={onClose}
        labelKey="settings.cards.advanced.title"
        descKey="settings.cards.advanced.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('16800'))
    const user = userEvent.setup()
    const portInput = screen.getByDisplayValue('16800')
    // fireEvent.change instead of userEvent.clear+type: the rpcPort onChange
    // clamps every keystroke (1024..65535) and falls back to the default on
    // empty input, so per-character drives produce intermediate clamp values
    // rather than the intended final number. fireEvent fires one change event
    // with the full target value, matching real-user paste/blur semantics.
    fireEvent.change(portInput, { target: { value: '17000' } })
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { rpcPort: 17000 },
    })
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByText(/restart to apply changes/i)).toBeNull()
  })

  it('Generate button populates rpcSecret', async () => {
    render(
      <AdvancedDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.advanced.title"
        descKey="settings.cards.advanced.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('abc12345'))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /generate/i }))
    const secretInput = screen
      .getAllByDisplayValue(/.+/)
      .find((el) => el.getAttribute('type') === 'password') as
      | HTMLInputElement
      | undefined
    // The value changes; just check it's not the original mock value
    expect(secretInput?.value).not.toBe('abc12345')
  })
})
