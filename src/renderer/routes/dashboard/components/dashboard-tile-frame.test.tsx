import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { DashboardTileLayout } from '@shared/types/settings'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { getDashboardTileSizeOptions } from '../layout/dashboard-layout'
import {
  DashboardTileFrame,
  type DashboardTileFrameLabels,
} from './dashboard-tile-frame'

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const labels: DashboardTileFrameLabels = {
  drag: 'Drag tile',
  remove: 'Remove tile',
  resize: 'Resize tile',
  sizeGroup: 'Tile size',
  size: (size) => size,
  unavailable: () => 'Not enough space',
}

const tile: DashboardTileLayout = {
  id: 'engine',
  enabled: true,
  x: 1,
  y: 1,
  w: 2,
  h: 1,
}

const layout: DashboardTileLayout[] = [
  tile,
  {
    id: 'speedUp',
    enabled: true,
    x: 0,
    y: 0,
    w: 4,
    h: 1,
  },
  {
    id: 'tasks',
    enabled: true,
    x: 0,
    y: 2,
    w: 4,
    h: 1,
  },
]

function renderFrame(
  props: Partial<React.ComponentProps<typeof DashboardTileFrame>> = {}
) {
  return render(
    <TooltipProvider>
      <DashboardTileFrame
        tile={tile}
        sizeOptions={getDashboardTileSizeOptions(layout, tile.id)}
        labels={labels}
        {...props}
      >
        <div>tile body</div>
      </DashboardTileFrame>
    </TooltipProvider>
  )
}

describe('DashboardTileFrame', () => {
  it('positions the tile on the numeric grid and names the tile container', () => {
    const { container } = renderFrame()
    const frame = container.querySelector('[data-dashboard-tile-id="engine"]')

    expect(frame).toHaveStyle({
      '--dashboard-grid-column': '2 / span 2',
      '--dashboard-grid-row': '2 / span 1',
    })
    expect(frame).toHaveClass('@container/tile')
    expect(frame).toHaveClass(
      '@[560px]:col-(--dashboard-grid-column)',
      '@[560px]:row-(--dashboard-grid-row)'
    )
  })

  it('keeps controls hidden outside editing mode', () => {
    const { container } = renderFrame()
    expect(screen.queryByRole('button', { name: 'Drag tile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resize tile' })).toBeNull()
    expect(screen.getByText('tile body')).toBeInTheDocument()
    expect(
      container.querySelector('[data-dashboard-tile-body]')
    ).not.toHaveAttribute('inert')
  })

  it('disables tile body interaction while edit controls own input', () => {
    const { container } = renderFrame({ editing: true })

    const body = container.querySelector('[data-dashboard-tile-body]')
    expect(body).toHaveAttribute('inert')
  })

  it('dispatches resize-handle pointer input in editing mode', () => {
    const onResizeHandlePointerDown = vi.fn()

    renderFrame({
      editing: true,
      onResizeHandlePointerDown,
    })

    const handle = screen.getByRole('button', { name: 'Resize tile' })
    fireEvent.pointerDown(handle)

    expect(onResizeHandlePointerDown).toHaveBeenCalledWith(
      'engine',
      expect.any(Object)
    )
  })

  it('shows edit controls and dispatches numeric span actions', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onDragHandlePointerDown = vi.fn()
    const onResize = vi.fn()
    const onRemove = vi.fn()

    renderFrame({
      editing: true,
      onDragHandlePointerDown,
      onResize,
      onRemove,
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Drag tile' }))
    await user.click(screen.getByRole('button', { name: 'Tile size' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '1x1' }))
    await user.click(screen.getByRole('button', { name: 'Remove tile' }))

    expect(onDragHandlePointerDown).toHaveBeenCalledWith(
      'engine',
      expect.any(Object)
    )
    expect(onResize).toHaveBeenCalledWith('engine', { w: 1, h: 1 })
    expect(onRemove).toHaveBeenCalledWith('engine')
  })

  it('marks the current size as selected', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderFrame({ editing: true })
    await user.click(screen.getByRole('button', { name: 'Tile size' }))

    expect(
      await screen.findByRole('menuitemradio', { name: '2x1' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('shows registered but capacity-blocked spans as disabled', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderFrame({ editing: true })
    await user.click(screen.getByRole('button', { name: 'Tile size' }))

    const blocked = await screen.findByRole('menuitemradio', {
      name: /1x2 Not enough space/,
    })
    expect(blocked).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('menuitemradio', { name: /3x1/ })).toBeNull()
  })
})
