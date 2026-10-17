import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), platform: 'darwin' },
}))

import { transport } from '@renderer/lib/transport'
import { SettingsFileSection } from './settings-file-section'

describe('SettingsFileSection', () => {
  beforeEach(() => {
    transport.platform = 'darwin'
    vi.mocked(transport.invoke)
      .mockReset()
      .mockImplementation(async (channel) =>
        channel === Queries.GetSettingsFileLocation
          ? { path: '/profile/settings.json' }
          : true
      )
  })

  it('shows a read-only desktop path and opens its directory without sending a path', async () => {
    const user = userEvent.setup()
    render(<SettingsFileSection />)
    const path = await screen.findByTitle('/profile/settings.json')
    expect(path).toHaveAttribute('data-slot', 'middle-ellipsis')
    expect(
      screen.getByRole('group', { name: 'Configuration file' })
    ).toContainElement(path)
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.OpenSettingsDirectory
    )
    expect(vi.mocked(transport.invoke).mock.calls).not.toContainEqual([
      Commands.OpenSettingsDirectory,
      '/profile/settings.json',
    ])
    expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.UpdateSettings)
  })

  it.each([false, new Error('Shell failure')])(
    'reports a failed folder action: %s',
    async (result) => {
      const user = userEvent.setup()
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Queries.GetSettingsFileLocation)
          return { path: '/profile/settings.json' }
        if (result instanceof Error) throw result
        return result
      })
      render(<SettingsFileSection />)
      await user.click(
        await screen.findByRole('button', { name: 'Open folder' })
      )
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t complete the action. Try again.'
      )
      expect(screen.getByRole('button', { name: 'Open folder' })).toBeEnabled()
    }
  )

  it('copies the server path locally without offering a folder action', async () => {
    transport.platform = 'web'
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    vi.mocked(transport.invoke).mockResolvedValue({
      path: '/config/settings.json',
    })
    render(<SettingsFileSection />)
    const path = await screen.findByTitle('/config/settings.json')
    expect(
      screen.getByRole('group', { name: 'Server configuration file' })
    ).toContainElement(path)
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(copy).toHaveBeenCalledWith('/config/settings.json')
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Copy path' })
          .querySelector('[aria-live="polite"]')
      ).toHaveTextContent('Copied')
    )
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetSettingsFileLocation
    )
  })

  it('reports clipboard failures without claiming the path was copied', async () => {
    transport.platform = 'web'
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Permission denied')
    )
    render(<SettingsFileSection />)
    await user.click(await screen.findByRole('button', { name: 'Copy path' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t complete the action. Try again.'
    )
    expect(
      screen
        .getByRole('button', { name: 'Copy path' })
        .querySelector('[aria-live="polite"]')
    ).toHaveTextContent('Copy path')
  })

  it('keeps actions unavailable until the path loads and allows retrying a failed load', async () => {
    const user = userEvent.setup()
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('Disconnected'))
    render(<SettingsFileSection />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByTitle('/profile/settings.json')).toBeInTheDocument()
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
