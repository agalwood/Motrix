import '@renderer/lib/i18n'
import type { DashboardLayoutSettings } from '@shared/types/settings'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => ({ tasks: [] }),
}))

vi.mock('react-router', async () => {
  const actual = (await vi.importActual('react-router')) as object
  return { ...actual, useNavigate: () => vi.fn() }
})

// Capture the `layout` prop DashboardGrid receives on every render so we can
// inspect what the page renders on the FIRST paint of a remount.
const layoutProps: DashboardLayoutSettings[] = []
vi.mock('./components/dashboard-grid', () => ({
  DashboardGrid: (props: { layout: DashboardLayoutSettings }) => {
    layoutProps.push(props.layout)
    return null
  },
}))

import { DashboardPage } from './dashboard-page'

function engineX(layout: DashboardLayoutSettings): number | undefined {
  return layout.tiles.find((t) => t.id === 'engine')?.x
}

describe('DashboardPage layout cache (no flash on remount)', () => {
  beforeEach(() => {
    listeners.clear()
    layoutProps.length = 0
  })

  it('renders the cached layout on the first paint of a remount', async () => {
    // A saved layout with the engine tile at a non-default position (1,1).
    const savedDashboard = {
      version: 1,
      columns: 4,
      tiles: [{ id: 'engine', enabled: true, x: 1, y: 1, w: 2, h: 1 }],
    }
    mockInvoke.mockResolvedValue({ dashboard: savedDashboard })

    // First mount: loads the saved layout (engine at x=1) and caches it.
    const first = render(<DashboardPage />)
    await waitFor(() => {
      const latest = layoutProps.at(-1)
      expect(latest && engineX(latest)).toBe(1)
    })
    first.unmount()

    // Remount with the settings fetch still in flight: a cache-less page would
    // paint the DEFAULT layout (engine at x=0) first, then FLIP-animate to x=1.
    layoutProps.length = 0
    mockInvoke.mockReturnValue(new Promise(() => {}))
    render(<DashboardPage />)

    // The very first layout the grid receives must already be the cached one.
    expect(engineX(layoutProps[0] as DashboardLayoutSettings)).toBe(1)
  })
})
