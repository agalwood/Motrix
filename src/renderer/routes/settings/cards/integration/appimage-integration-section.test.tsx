import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
  },
}))

import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppImageIntegrationView } from '@shared/types/appimage-integration'
import { AppImageIntegrationSection } from './appimage-integration-section'

const invoke = vi.mocked(transport.invoke)

function statusOnly(view: AppImageIntegrationView) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === Queries.GetAppImageIntegrationStatus) return view
    throw new Error(`unexpected channel: ${channel}`)
  })
}

beforeEach(() => {
  invoke.mockReset()
})

describe('AppImageIntegrationSection', () => {
  it('renders nothing outside an AppImage environment', async () => {
    statusOnly({ supported: false })
    const { container } = render(<AppImageIntegrationSection />)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Queries.GetAppImageIntegrationStatus)
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the status query fails (web shell)', async () => {
    invoke.mockRejectedValue(new Error('unknown query'))
    const { container } = render(<AppImageIntegrationSection />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('offers enable when not integrated', async () => {
    statusOnly({
      supported: true,
      decision: 'unset',
      owner: null,
      status: null,
    })
    render(<AppImageIntegrationSection />)
    expect(
      await screen.findByRole('button', { name: 'Enable desktop integration' })
    ).toBeInTheDocument()
    expect(screen.getByText('Not integrated with this desktop.')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Remove desktop integration' })
    ).not.toBeInTheDocument()
  })

  it('enables integration and shows the refreshed state', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === Queries.GetAppImageIntegrationStatus) {
        return {
          supported: true,
          decision: 'declined',
          owner: null,
          status: null,
        }
      }
      if (channel === Commands.EnableAppImageIntegration) {
        return {
          supported: true,
          decision: 'accepted',
          owner: 'self',
          status: 'healthy',
        }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
    render(<AppImageIntegrationSection />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Enable desktop integration' })
    )
    expect(
      await screen.findByRole('button', { name: 'Remove desktop integration' })
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(Commands.EnableAppImageIntegration)
    expect(screen.getByText('Integrated with this desktop.')).toBeVisible()
  })

  it('removes integration and returns to the enable state', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === Queries.GetAppImageIntegrationStatus) {
        return {
          supported: true,
          decision: 'accepted',
          owner: 'self',
          status: 'healthy',
        }
      }
      if (channel === Commands.RemoveAppImageIntegration) {
        return {
          supported: true,
          decision: 'declined',
          owner: null,
          status: null,
        }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
    render(<AppImageIntegrationSection />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove desktop integration' })
    )
    expect(
      await screen.findByRole('button', { name: 'Enable desktop integration' })
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(Commands.RemoveAppImageIntegration)
  })

  it('shows the failed state with both retry and remove', async () => {
    statusOnly({
      supported: true,
      decision: 'accepted',
      owner: 'self',
      status: 'failed',
    })
    render(<AppImageIntegrationSection />)
    expect(
      await screen.findByText('Desktop integration incomplete')
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Enable desktop integration' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove desktop integration' })
    ).toBeInTheDocument()
  })

  it('explains why a safe removal was blocked', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === Queries.GetAppImageIntegrationStatus) {
        return {
          supported: true,
          decision: 'accepted',
          owner: 'self',
          status: 'healthy',
        }
      }
      if (channel === Commands.RemoveAppImageIntegration) {
        return {
          supported: true,
          decision: 'accepted',
          owner: 'self',
          status: 'failed',
        }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
    render(<AppImageIntegrationSection />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove desktop integration' })
    )
    expect(
      await screen.findByText(/kept its desktop entry to avoid leaving/u)
    ).toBeVisible()
  })

  it('blocks removal for an externally-owned integration', async () => {
    statusOnly({
      supported: true,
      decision: 'accepted',
      owner: 'external',
      status: 'healthy',
    })
    render(<AppImageIntegrationSection />)
    expect(
      await screen.findByText(
        'Desktop integration is provided by another Motrix install.'
      )
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Remove desktop integration' })
    ).not.toBeInTheDocument()
  })
})
