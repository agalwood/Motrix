import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { ReducedMotionSync } from '@renderer/components/reduced-motion-sync'
import { setAppReduceMotion } from '@renderer/lib/reduced-motion'
import { transport } from '@renderer/lib/transport'
import type { EventListener } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyTasks } from './empty-tasks'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

let savedReduceMotion = false
const motionListeners = new Set<EventListener>()

beforeEach(() => {
  vi.clearAllMocks()
  savedReduceMotion = false
  setAppReduceMotion(false)
  motionListeners.clear()
  vi.mocked(transport.on).mockImplementation((channel, listener) => {
    if (channel === Events.ReducedMotionChanged) motionListeners.add(listener)
  })
  vi.mocked(transport.off).mockImplementation((channel, listener) => {
    if (channel === Events.ReducedMotionChanged)
      motionListeners.delete(listener)
  })
  vi.mocked(transport.invoke).mockImplementation(async (channel, patch) => {
    if (channel === Commands.UpdateSettings) {
      savedReduceMotion = (patch as { app: { reduceMotion: boolean } }).app
        .reduceMotion
      for (const listener of motionListeners)
        listener({ reduceMotion: savedReduceMotion })
    }
    return { app: { reduceMotion: savedReduceMotion } }
  })
})

afterEach(() => {
  cleanup()
  setAppReduceMotion(false)
  delete document.documentElement.dataset.reducedMotion
  vi.unstubAllGlobals()
})

function renderWithMotionSync(ui: ReactElement) {
  return render(
    <>
      <ReducedMotionSync />
      {ui}
    </>
  )
}

describe('EmptyTasks', () => {
  it('renders the "no tasks" message when total tasks is zero', () => {
    const { container } = renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).toHaveAttribute('data-preset', 'blue-pink')
    expect(
      screen.getByRole('button', { name: /tune glass motion/i })
    ).toBeInTheDocument()
  })

  it('controls the glass effects without remounting the empty state', async () => {
    const { container } = renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    const gradient = container.querySelector(
      '[data-slot="cubic-glass-gradient"]'
    )

    fireEvent.click(screen.getByRole('button', { name: /tune glass motion/i }))
    fireEvent.click(
      await screen.findByRole('switch', { name: /breathing light/i })
    )
    expect(gradient).toHaveAttribute('data-effect-breathing', 'false')

    const positionConstraint = screen.getByRole('switch', {
      name: /gravity position limit/i,
    })
    expect(positionConstraint).toBeChecked()
    fireEvent.click(positionConstraint)
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'false')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'true')

    fireEvent.click(screen.getByRole('switch', { name: /motion effects/i }))
    await waitFor(() =>
      expect(gradient).toHaveAttribute('data-effect-load-fade', 'false')
    )
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'false')
    expect(positionConstraint).toHaveAttribute('aria-disabled', 'true')
    expect(gradient?.querySelectorAll('canvas')).toHaveLength(1)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { reduceMotion: true },
    })

    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(positionConstraint).toBeChecked()
    expect(positionConstraint).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('switch', { name: /motion effects/i })
    ).not.toBeChecked()
    expect(savedReduceMotion).toBe(true)

    fireEvent.click(screen.getByRole('switch', { name: /motion effects/i }))
    await waitFor(() =>
      expect(positionConstraint).not.toHaveAttribute('aria-disabled', 'true')
    )
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'true')
    expect(transport.invoke).toHaveBeenLastCalledWith(Commands.UpdateSettings, {
      app: { reduceMotion: false },
    })
    const horizontalSpeed = screen.getByRole('group', {
      name: /horizontal speed/i,
    })
    const horizontalSpeedInput = horizontalSpeed.querySelector(
      'input[type="range"]'
    )
    expect(horizontalSpeedInput).toHaveValue('50')
    fireEvent.change(horizontalSpeedInput as HTMLInputElement, {
      target: { value: '20' },
    })
    expect(gradient).toHaveAttribute('data-horizontal-speed', '20')
  })

  it('hydrates the global preference and reflects changes while the debug menu is open', async () => {
    savedReduceMotion = true
    const { container } = renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    const canvas = container.querySelector('canvas')
    fireEvent.click(screen.getByRole('button', { name: /tune glass motion/i }))
    const master = await screen.findByRole('switch', {
      name: /motion effects/i,
    })
    await waitFor(() => expect(master).not.toBeChecked())
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)

    act(() => {
      for (const listener of motionListeners) listener({ reduceMotion: false })
    })
    expect(master).toBeChecked()
    act(() => {
      for (const listener of motionListeners) listener({ reduceMotion: true })
    })
    expect(master).not.toBeChecked()
    expect(container.querySelector('canvas')).toBe(canvas)
  })

  it('keeps the previous state and permits retry when saving fails', async () => {
    renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /tune glass motion/i }))
    const master = await screen.findByRole('switch', {
      name: /motion effects/i,
    })
    let rejectSave!: (reason: Error) => void
    vi.mocked(transport.invoke).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        })
    )
    fireEvent.click(master)
    expect(master).toHaveAttribute('aria-disabled', 'true')
    expect(master).toBeChecked()
    await act(async () => rejectSave(new Error('disk full')))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t save the motion setting/i
    )
    expect(master).not.toHaveAttribute('aria-disabled', 'true')
    expect(master).toBeChecked()

    fireEvent.click(master)
    await waitFor(() => expect(master).not.toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows system reduced motion as disabled and prevents the debug menu from overriding it', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )
    renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /tune glass motion/i }))
    const master = await screen.findByRole('switch', {
      name: /motion effects/i,
    })
    expect(master).not.toBeChecked()
    expect(master).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText(/motion is disabled by your system/i)
    ).toBeInTheDocument()
    fireEvent.click(master)
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(master).not.toBeChecked()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )
  })

  it('renders search hint and fires onClearSearch', () => {
    const onClear = vi.fn()
    const { container } = renderWithMotionSync(
      <EmptyTasks
        filter="all"
        search="xyz"
        hasAnyTasks
        onClearSearch={onClear}
      />
    )
    expect(screen.getByText(/xyz/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(onClear).toHaveBeenCalled()
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).not.toBeInTheDocument()
  })

  it('renders filter-only hint when search is empty but filter has no matches', () => {
    renderWithMotionSync(
      <EmptyTasks
        filter="error"
        search=""
        hasAnyTasks
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no tasks match this filter/i)).toBeInTheDocument()
  })
})
