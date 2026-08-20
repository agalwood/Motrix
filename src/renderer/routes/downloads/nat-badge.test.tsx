import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { NatState, type NatStatus } from '@shared/types/nat'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, openExternal } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternal: vi.fn(),
}))
const natState = vi.hoisted(() => ({ status: null as NatStatus | null }))

vi.mock('@renderer/hooks/use-nat-status', () => ({
  useNatStatus: () => natState.status,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke,
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ openExternal }),
}))

const { NatBadge } = await import('./nat-badge')

describe('NatBadge', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ ok: true })
    openExternal.mockReset()
    natState.status = {
      state: NatState.Failed,
      enabled: true,
      activeMappings: [],
      gatewayInfo: null,
      lastError: null,
      lastDiagnostic: null,
      retryAttempt: 3,
      maxRetries: 3,
    }
  })

  it('offers the official troubleshooting guide in the failed menu', async () => {
    render(<NatBadge />)

    fireEvent.click(screen.getByRole('button', { name: 'NAT failed' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Troubleshoot NAT' })
    )

    expect(openExternal).toHaveBeenCalledWith(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.en
    )
  })
})
