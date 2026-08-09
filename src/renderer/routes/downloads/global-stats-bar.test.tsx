import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Queries } from '@shared/protocol/queries'
import { NatState } from '@shared/types/nat'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/use-global-stats', () => ({
  useGlobalStats: () => ({
    stats: {
      totalDownloadSpeed: 16_500_000,
      totalUploadSpeed: 4_000_000,
      activeTasks: 4,
      waitingTasks: 0,
      stoppedTasks: 42,
    },
  }),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockImplementation((channel: string) => {
      if (channel === Queries.GetEngineStatus) {
        return Promise.resolve({ state: 'ready' })
      }
      if (channel === Queries.GetNatStatus) {
        return Promise.resolve({
          state: NatState.Active,
          enabled: true,
          activeMappings: [],
          gatewayInfo: null,
          lastError: null,
          lastDiagnostic: null,
          retryAttempt: 0,
          maxRetries: 3,
        })
      }
      return Promise.resolve(undefined)
    }),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { GlobalStatsBar } from './global-stats-bar'

describe('GlobalStatsBar', () => {
  it('renders formatted speeds with engine and nat badges', async () => {
    render(<GlobalStatsBar />)
    // formatBytes(16_500_000) = "15.7 MB" (1024-base, value.toFixed(1))
    expect(screen.getByText(/15\.7 MB\/s/)).toBeInTheDocument()
    expect(await screen.findByText(/Engine ready/)).toBeInTheDocument()
    expect(await screen.findByText(/NAT active/)).toBeInTheDocument()
  })
})
