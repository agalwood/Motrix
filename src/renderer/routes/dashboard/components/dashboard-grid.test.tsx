import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { DEFAULT_DASHBOARD_LAYOUT } from '@shared/schemas/dashboard-layout'
import type {
  DashboardLayoutSettings,
  DashboardTileLayout,
} from '@shared/types/settings'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardTileViewport } from '../layout/dashboard-registry'
import { DashboardGrid } from './dashboard-grid'

const renderCounts = new Map<string, number>()

function renderTile(
  tile: DashboardTileLayout,
  viewport: DashboardTileViewport
) {
  renderCounts.set(tile.id, (renderCounts.get(tile.id) ?? 0) + 1)
  return (
    <div>
      {tile.id}-{tile.x},{tile.y}-{tile.w}x{tile.h}-{viewport.contentLevel}-
      {viewport.orientation}-viewport:{viewport.span.w}x{viewport.span.h}
    </div>
  )
}

function renderDefaultGrid() {
  return render(
    <DashboardGrid layout={DEFAULT_DASHBOARD_LAYOUT} renderTile={renderTile} />
  )
}

function layoutWithDisabledTiles(
  ...ids: DashboardTileLayout['id'][]
): DashboardLayoutSettings {
  return {
    ...DEFAULT_DASHBOARD_LAYOUT,
    tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) =>
      ids.includes(tile.id) ? { ...tile, enabled: false } : tile
    ),
  }
}

function makeRect({
  x = 0,
  y = 0,
  width = 100,
  height = 128,
}: {
  x?: number
  y?: number
  width?: number
  height?: number
} = {}): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  }
}

function gridTileRect(element: HTMLElement): DOMRect {
  const column = Number.parseInt(
    element.style.getPropertyValue('--dashboard-grid-column'),
    10
  )
  const row = Number.parseInt(
    element.style.getPropertyValue('--dashboard-grid-row'),
    10
  )
  return makeRect({
    x: Number.isNaN(column) ? 0 : (column - 1) * 100,
    y: Number.isNaN(row) ? 0 : (row - 1) * 128,
  })
}

function getResizeHandle(tileId: string): HTMLElement {
  return within(screen.getByTestId(`dashboard-tile-${tileId}`)).getByRole(
    'button',
    {
      name: /Resize tile|调整卡片大小/i,
    }
  )
}

function installAnimationFrameQueue() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 0
  const requestSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    })
  const cancelSpy = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      callbacks.delete(id)
    })

  return {
    callbacks,
    runNext() {
      const next = callbacks.entries().next()
      if (next.done) throw new Error('no scheduled animation frame')
      const [id, callback] = next.value
      callbacks.delete(id)
      act(() => callback(performance.now()))
    },
    restore() {
      requestSpy.mockRestore()
      cancelSpy.mockRestore()
    },
  }
}

async function selectTileSize(tileId: string, size: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  const [width, height] = size.split('x')
  const sizeMenu = within(screen.getByTestId(`dashboard-tile-${tileId}`))
    .getAllByRole('button', {
      name: /Tile size|卡片尺寸/i,
    })
    .find((button) => button.getAttribute('aria-haspopup') === 'menu')
  if (!sizeMenu) throw new Error(`no size menu for ${tileId}`)
  sizeMenu.focus()
  await user.keyboard('{Enter}')
  await user.click(
    await screen.findByRole('menuitemradio', {
      name: new RegExp(`${width}\\s*[×x]\\s*${height}`),
    })
  )
}

async function openPresetMenu() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(
    screen.getByRole('button', {
      name: /Presets|预设/i,
    })
  )
  await screen.findByRole('menu')
  return user
}

async function selectPreset(name: RegExp) {
  const user = await openPresetMenu()
  await user.click(screen.getByRole('menuitem', { name }))
}

const COMPACT_PRESET_TILES: DashboardTileLayout[] = [
  { id: 'engine', enabled: true, x: 0, y: 0, w: 2, h: 1 },
  { id: 'speedLimit', enabled: true, x: 2, y: 0, w: 2, h: 1 },
  { id: 'speedUp', enabled: true, x: 0, y: 1, w: 1, h: 1 },
  { id: 'speedDown', enabled: true, x: 1, y: 1, w: 1, h: 1 },
  { id: 'active', enabled: true, x: 2, y: 1, w: 1, h: 1 },
  { id: 'transfer', enabled: true, x: 3, y: 1, w: 1, h: 1 },
  { id: 'tasks', enabled: true, x: 0, y: 2, w: 2, h: 1 },
  { id: 'nat', enabled: true, x: 2, y: 2, w: 2, h: 1 },
  { id: 'activity', enabled: false, x: 0, y: 0, w: 1, h: 1 },
]

describe('DashboardGrid', () => {
  afterEach(() => {
    document.body.classList.remove('is-dashboard-dragging')
    document.body.classList.remove('is-dashboard-resizing')
    renderCounts.clear()
    vi.unstubAllGlobals()
  })

  it('renders enabled tiles outside configure mode', () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('speedUp')}
        renderTile={renderTile}
      />
    )

    expect(
      screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('transfer-2,1-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('activity-0,2-4x1-focus-wide-viewport:4x1')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-tile-tasks')).not.toBeInTheDocument()
    expect(screen.getByTestId('dashboard-grid').className).toContain(
      '@[560px]:grid-rows-[repeat(3,minmax(8rem,1fr))]'
    )
    expect(
      screen.queryByText('speedUp-2,0-1x1-compact-square-viewport:1x1')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Configure|配置/i })
    ).toBeEnabled()
  })

  it('lets narrow single-column rows grow with content inside a scroll viewport', () => {
    renderDefaultGrid()

    const grid = screen.getByTestId('dashboard-grid')
    // Below the breakpoint, rows must track content height (8rem is only a
    // floor) — a fixed inline row template would clip taller tiles.
    expect(grid.style.gridAutoRows).toBe('')
    expect(grid.className).toContain('auto-rows-[minmax(8rem,auto)]')
    expect(grid.className).toContain('@[560px]:auto-rows-[minmax(8rem,1fr)]')
    // The viewport height clamp is wide-only so the stacked column can grow
    // past the viewport and scroll instead of being cut off.
    expect(grid.className).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/)
    expect(grid.className).not.toMatch(/(?:^|\s)min-h-0(?:\s|$)/)
    expect(grid.className).toContain('@[560px]:min-h-0')
    expect(grid.className).toContain('@[560px]:flex-1')

    const viewport = grid.parentElement
    expect(viewport?.className).toContain('overflow-y-auto')
    expect(viewport?.className).toContain('@[560px]:overflow-visible')
  })

  it('keeps grid tracks stable when entering configure mode', () => {
    renderDefaultGrid()
    const grid = screen.getByTestId('dashboard-grid')

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    // Padding/border on the grid shrink its content box, which resizes every
    // tile track — edit-mode chrome must not take layout space.
    expect(grid.className).not.toMatch(/(?:^|\s)p-2(?:\s|$)/)
    expect(grid.className).not.toMatch(/(?:^|\s)border(?:\s|$)/)
  })

  it('renders per-cell guide slots aligned to grid tracks while configuring', () => {
    renderDefaultGrid()

    expect(screen.queryAllByTestId('dashboard-grid-guide')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    // Guide slots are real grid items (one per cell), so they align with the
    // rendered tracks and gaps exactly — painted background gradients cannot.
    const guides = screen.getAllByTestId('dashboard-grid-guide')
    // The default board fits 3 rows exactly; guideRowCount=max(3,3)=3
    // → 4 cols × 3 rows = 12 guide slots
    expect(guides).toHaveLength(12)
    expect(guides[0]?.style.gridColumn).toBe('1')
    expect(guides[0]?.style.gridRow).toBe('1')
    // last guide: index 11 → col=(11%4)+1=4, row=floor(11/4)+1=3
    expect(guides[11]?.style.gridColumn).toBe('4')
    expect(guides[11]?.style.gridRow).toBe('3')
    // Guides must stay visible against the background: the plain border token
    // (oklch 0.922 light / white-10% dark) was too faint.
    expect(guides[0]?.className).toContain('border-muted-foreground/40')
    // The grid itself paints no gradient lines anymore.
    expect(screen.getByTestId('dashboard-grid').style.backgroundImage).toBe('')
  })

  it('disables the configure action when configuration is not available', () => {
    render(
      <DashboardGrid
        layout={DEFAULT_DASHBOARD_LAYOUT}
        renderTile={renderTile}
        configureDisabled
      />
    )

    expect(
      screen.getByRole('button', { name: /Configure|配置/i })
    ).toBeDisabled()
  })

  it('cleans up an active interaction on narrow exit and unmount', async () => {
    let resizeCallback: ResizeObserverCallback | undefined
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    const { unmount } = renderDefaultGrid()
    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    expect(
      screen.getByRole('button', { name: /Presets|预设/i })
    ).toBeInTheDocument()

    const grid = screen.getByTestId('dashboard-grid')
    const firstDragHandle = within(
      screen.getByTestId('dashboard-tile-engine')
    ).getByRole('button', {
      name: /Drag tile|拖拽/i,
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(firstDragHandle, {
      setPointerCapture: {
        configurable: true,
        value: setPointerCapture,
      },
      releasePointerCapture: {
        configurable: true,
        value: releasePointerCapture,
      },
    })
    fireEvent.pointerDown(firstDragHandle, {
      clientX: 10,
      clientY: 10,
      pointerId: 7,
    })
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(document.body).toHaveClass('is-dashboard-dragging')
    expect(grid.style.touchAction).toBe('none')

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 559 } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Presets|预设/i })
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: /Configure|配置/i })
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /Tile size|卡片尺寸/i })
    ).not.toBeInTheDocument()
    expect(document.body).not.toHaveClass('is-dashboard-dragging')
    expect(grid.style.touchAction).toBe('')
    expect(releasePointerCapture).toHaveBeenCalledWith(7)

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 560 } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    })
    const configure = screen.getByRole('button', { name: /Configure|配置/i })
    await waitFor(() => expect(configure).toBeEnabled())
    fireEvent.click(configure)

    const secondDragHandle = within(
      screen.getByTestId('dashboard-tile-engine')
    ).getByRole('button', {
      name: /Drag tile|拖拽/i,
    })
    const releaseOnUnmount = vi.fn()
    Object.defineProperties(secondDragHandle, {
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      releasePointerCapture: {
        configurable: true,
        value: releaseOnUnmount,
      },
    })
    fireEvent.pointerDown(secondDragHandle, {
      clientX: 10,
      clientY: 10,
      pointerId: 8,
    })
    expect(document.body).toHaveClass('is-dashboard-dragging')

    unmount()

    expect(document.body).not.toHaveClass('is-dashboard-dragging')
    expect(releaseOnUnmount).toHaveBeenCalledWith(8)
  })

  it('groups the configure actions with visible labels', () => {
    renderDefaultGrid()

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    // Actions render as nested button groups — an edit cluster
    // (cancel/reset/apply) and a gapped preset/Add cluster. The outer group is
    // the one wrapping all five buttons.
    const group = screen
      .getAllByRole('group')
      .find(
        (candidate) => within(candidate).queryAllByRole('button').length === 5
      )
    if (!group) {
      throw new Error('no outer group with all five configure actions')
    }

    const cancel = within(group).getByRole('button', { name: /Cancel|取消/i })
    const reset = within(group).getByRole('button', {
      name: /^(Reset|重置)$/i,
    })
    const apply = within(group).getByRole('button', { name: /Apply|应用/i })
    const presets = within(group).getByRole('button', {
      name: /Presets|预设/i,
    })
    const add = within(group).getByRole('button', { name: /Add|添加/i })
    // Full mode shows the label text inline (not icon-only).
    expect(cancel).toHaveTextContent(/Cancel|取消/i)
    expect(reset).toHaveTextContent(/^(Reset|重置)$/i)
    expect(apply).toHaveTextContent(/Apply|应用/i)
    // Add sits at the trailing edge so its end-aligned dropdown hangs
    // under the toolbar's right corner.
    expect(within(group).getAllByRole('button')).toEqual([
      cancel,
      reset,
      apply,
      presets,
      add,
    ])
  })

  it('shows all presets only while configuring and labels exact or custom drafts', async () => {
    renderDefaultGrid()

    expect(
      screen.queryByRole('button', { name: /Presets|预设/i })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    const presetTrigger = screen.getByRole('button', {
      name: /Presets: Balanced|预设：?均衡/i,
    })
    expect(presetTrigger).toHaveTextContent(/^(Balanced|均衡)$/i)
    expect(presetTrigger).not.toHaveTextContent(/Presets|预设/i)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(presetTrigger)

    const balanced = await screen.findByRole('menuitem', {
      name: /Balanced|均衡/i,
    })
    expect(
      screen.getByRole('menuitem', { name: /Task Focus|任务优先/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Speed Focus|速度优先/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Compact|紧凑/i })
    ).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    expect(balanced.querySelector('svg')).not.toBeNull()

    await user.keyboard('{Escape}')
    fireEvent.click(
      within(screen.getByTestId('dashboard-tile-engine')).getByRole('button', {
        name: /Remove tile|移除卡片/i,
      })
    )
    const customTrigger = screen.getByRole('button', {
      name: /Presets: Custom|预设：?自定义/i,
    })
    expect(customTrigger).toHaveTextContent(/^(Custom|自定义)$/i)
    expect(customTrigger).not.toHaveTextContent(/Presets|预设/i)
  })

  it('uses Compact as a full draft replacement and persists only on Apply', async () => {
    const onApply = vi.fn()
    render(
      <DashboardGrid
        layout={DEFAULT_DASHBOARD_LAYOUT}
        renderTile={renderTile}
        onApply={onApply}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectPreset(/Compact|紧凑/i)

    expect(onApply).not.toHaveBeenCalled()
    expect(
      screen.getByText('engine-0,0-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('speedLimit-2,0-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('speedUp-0,1-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('speedDown-1,1-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('active-2,1-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('transfer-3,1-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('tasks-0,2-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()
    expect(
      screen.getByText('nat-2,2-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith({
        version: 1,
        columns: 4,
        tiles: COMPACT_PRESET_TILES,
      })
    })
  })

  it('disables NAT when Task Focus replaces a Compact draft', async () => {
    renderDefaultGrid()

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectPreset(/Compact|紧凑/i)
    expect(screen.getByTestId('dashboard-tile-nat')).toBeInTheDocument()

    await selectPreset(/Task Focus|任务优先/i)

    expect(screen.queryByTestId('dashboard-tile-nat')).not.toBeInTheDocument()
    expect(
      screen.getByText('tasks-0,0-2x3-focus-tall-viewport:2x3')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /Presets: Task Focus|预设：?任务优先/i,
      })
    ).toBeInTheDocument()
  })

  it('undoes one preset application back to the immediately previous draft', async () => {
    renderDefaultGrid()

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.click(
      within(screen.getByTestId('dashboard-tile-engine')).getByRole('button', {
        name: /Remove tile|移除卡片/i,
      })
    )
    expect(screen.queryByTestId('dashboard-tile-engine')).toBeNull()

    await selectPreset(/Compact|紧凑/i)
    expect(screen.getByTestId('dashboard-tile-engine')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-tile-nat')).toBeInTheDocument()

    const user = await openPresetMenu()
    await user.click(
      screen.getByRole('menuitem', {
        name: /Undo last preset|撤销上次预设/i,
      })
    )

    expect(screen.queryByTestId('dashboard-tile-engine')).toBeNull()
    expect(screen.queryByTestId('dashboard-tile-nat')).toBeNull()
    expect(
      screen.getByRole('button', {
        name: /Presets: Custom|预设：?自定义/i,
      })
    ).toBeInTheDocument()
  })

  it.each(['resize', 'remove', 'drag'] as const)(
    'clears preset undo after a manual %s',
    async (operation) => {
      renderDefaultGrid()

      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
      await selectPreset(/Compact|紧凑/i)

      const menuUser = await openPresetMenu()
      expect(
        screen.getByRole('menuitem', {
          name: /Undo last preset|撤销上次预设/i,
        })
      ).toBeInTheDocument()
      await menuUser.keyboard('{Escape}')
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      if (operation === 'resize') {
        await selectTileSize('engine', '1x1')
      } else if (operation === 'remove') {
        fireEvent.click(
          within(screen.getByTestId('dashboard-tile-engine')).getByRole(
            'button',
            { name: /Remove tile|移除卡片/i }
          )
        )
      } else {
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ width: 400, height: 384 })
        )
        fireEvent.pointerDown(
          within(screen.getByTestId('dashboard-tile-engine')).getByRole(
            'button',
            { name: /Drag tile|拖拽/i }
          )
        )
        fireEvent.pointerUp(window)
      }

      await openPresetMenu()
      expect(
        screen.queryByRole('menuitem', {
          name: /Undo last preset|撤销上次预设/i,
        })
      ).not.toBeInTheDocument()
    }
  )

  it('passes capacity failures through to disabled size options', async () => {
    renderDefaultGrid()

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const sizeMenu = within(screen.getByTestId('dashboard-tile-engine'))
      .getAllByRole('button', {
        name: /Tile size|卡片尺寸/i,
      })
      .find((button) => button.getAttribute('aria-haspopup') === 'menu')
    if (!sizeMenu) throw new Error('no size menu for engine')
    await user.click(sizeMenu)

    const expansion = await screen.findByRole('menuitemradio', {
      name: /2\s*[×x]\s*1/i,
    })
    expect(expansion).toHaveAttribute('aria-disabled', 'true')
    expect(expansion).toHaveTextContent(/Not enough space|空间不足/i)
  })

  it('enters configure mode and cancels draft resize changes', async () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('speedLimit')}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectTileSize('engine', '2x1')

    expect(
      screen.getByText('engine-0,0-2x1-summary-wide-viewport:2x1')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/i }))
    expect(
      screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
  })

  it('applies draft layout changes', async () => {
    const onApply = vi.fn()
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('speedLimit')}
        renderTile={renderTile}
        onApply={onApply}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectTileSize('engine', '2x1')
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          tiles: expect.arrayContaining([
            expect.objectContaining({ id: 'engine', w: 2, h: 1 }),
          ]),
        })
      )
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply|应用/i })).toBeNull()
    })
  })

  it('keeps configure mode open when saving fails', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('disk full'))
    render(
      <DashboardGrid
        layout={DEFAULT_DASHBOARD_LAYOUT}
        renderTile={renderTile}
        onApply={onApply}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        /Could not save layout|布局保存失败/i
      )
    })
    expect(
      screen.getByRole('button', { name: /Apply|应用/i })
    ).toBeInTheDocument()
  })

  it('restores a hidden tile from the Add menu while configuring', async () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('speedUp')}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    expect(
      screen.queryByText('speedUp-2,0-1x1-compact-square-viewport:1x1')
    ).not.toBeInTheDocument()
    // Hidden tiles live in the header Add menu, not a bottom strip that would
    // steal height from the 1fr grid rows.
    expect(screen.queryByTestId('dashboard-hidden-tiles')).toBeNull()

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: /Add|添加/i }))
    await user.click(
      await screen.findByRole('menuitem', {
        name: /Upload speed|上传速度/i,
      })
    )

    expect(screen.getByTestId('dashboard-tile-speedUp')).toHaveAttribute(
      'data-enabled',
      'true'
    )
  })

  it('uses semantic title casing for English tile names in the Add menu', async () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles(
          'engine',
          'speedLimit',
          'speedUp',
          'speedDown',
          'active',
          'tasks',
          'transfer'
        )}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: /Add|添加/i }))

    const menu = await screen.findByRole('menu')
    for (const title of [
      'Engine',
      'Speed Limit',
      'Upload Speed',
      'Download Speed',
      'Active Tasks',
      'Tasks',
      'Transfer',
      'NAT',
    ]) {
      expect(within(menu).getByText(title, { exact: true })).toBeInTheDocument()
    }
  })

  it('keeps the Add menu open and explains capacity-blocked hidden tiles', async () => {
    // speedUp + speedDown are both addable. Nat remains hidden by default, but
    // once these two tiles return the fixed 4x3 canvas is full, so Nat remains
    // visible with localized capacity feedback.
    render(
      <DashboardGrid
        layout={{
          ...DEFAULT_DASHBOARD_LAYOUT,
          tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => ({
            ...tile,
            enabled:
              tile.enabled && tile.id !== 'speedUp' && tile.id !== 'speedDown',
          })),
        }}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: /Add|添加/i }))
    await user.click(
      await screen.findByRole('menuitem', {
        name: /Upload speed|上传速度/i,
      })
    )

    // Re-adding one tile keeps the menu open for the next pick.
    const remaining = screen.getByRole('menuitem', {
      name: /Download speed|下载速度/i,
    })
    await user.click(remaining)

    const blockedNat = await screen.findByRole('menuitem', {
      name: /NAT.*(?:Not enough space|空间不足)/i,
    })
    expect(blockedNat).toHaveAttribute('aria-disabled', 'true')
    expect(blockedNat).toHaveTextContent(/Not enough space|空间不足/i)
    expect(screen.getByTestId('dashboard-tile-speedUp')).toHaveAttribute(
      'data-enabled',
      'true'
    )
    expect(screen.getByTestId('dashboard-tile-speedDown')).toHaveAttribute(
      'data-enabled',
      'true'
    )
  })

  it('disables the Add menu when no tiles are hidden', () => {
    // Every tile enabled (including the default-hidden nat) → nothing to add.
    render(
      <DashboardGrid
        layout={{
          ...DEFAULT_DASHBOARD_LAYOUT,
          tiles: [
            { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
            { id: 'speedLimit', enabled: true, x: 1, y: 0, w: 1, h: 1 },
            { id: 'speedUp', enabled: true, x: 2, y: 0, w: 1, h: 1 },
            { id: 'speedDown', enabled: true, x: 3, y: 0, w: 1, h: 1 },
            { id: 'active', enabled: true, x: 0, y: 1, w: 1, h: 1 },
            { id: 'transfer', enabled: true, x: 1, y: 1, w: 1, h: 1 },
            { id: 'nat', enabled: true, x: 2, y: 1, w: 1, h: 1 },
            { id: 'activity', enabled: true, x: 3, y: 1, w: 1, h: 1 },
            { id: 'tasks', enabled: true, x: 0, y: 2, w: 2, h: 1 },
          ],
        }}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    expect(screen.getByRole('button', { name: /Add|添加/i })).toBeDisabled()
  })

  it('keeps hidden tiles recoverable when their saved cells are occupied', async () => {
    render(
      <DashboardGrid
        layout={{
          ...DEFAULT_DASHBOARD_LAYOUT,
          tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => {
            if (tile.id === 'engine') return { ...tile, enabled: false }
            if (tile.id === 'speedUp') return { ...tile, x: 0, y: 0 }
            return { ...tile }
          }),
        }}
        renderTile={renderTile}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

    expect(screen.queryByTestId('dashboard-tile-engine')).toBeNull()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: /Add|添加/i }))
    await user.click(await screen.findByRole('menuitem', { name: /ENGINE/i }))
    expect(screen.getByTestId('dashboard-tile-engine')).toHaveAttribute(
      'data-enabled',
      'true'
    )
  })

  describe('pointer resize', () => {
    it('exposes a named resize handle only while configuring', () => {
      renderDefaultGrid()

      expect(
        screen.queryByRole('button', {
          name: /Resize tile|调整卡片大小/i,
        })
      ).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))

      expect(getResizeHandle('engine')).toBeInTheDocument()
    })

    it.each([
      ['secondary button', { button: 2, isPrimary: true }],
      ['non-primary pointer', { button: 0, isPrimary: false }],
    ] as const)(
      'ignores a %s resize start without interaction side effects',
      (_case, pointerInit) => {
        const raf = installAnimationFrameQueue()
        try {
          renderDefaultGrid()
          const grid = screen.getByTestId('dashboard-grid')
          vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
            makeRect({ width: 400, height: 384 })
          )
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const engine = screen.getByTestId('dashboard-tile-engine')
          const handle = getResizeHandle('engine')
          const setPointerCapture = vi.fn()
          Object.defineProperty(handle, 'setPointerCapture', {
            configurable: true,
            value: setPointerCapture,
          })

          const pointerDown = new MouseEvent('pointerdown', {
            bubbles: true,
            button: pointerInit.button,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
          Object.defineProperties(pointerDown, {
            isPrimary: {
              value: pointerInit.isPrimary,
            },
            pointerId: {
              value: 28,
            },
            pointerType: {
              value: 'touch',
            },
          })
          fireEvent(handle, pointerDown)
          fireEvent.pointerMove(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 28,
          })
          fireEvent.pointerUp(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 28,
          })

          expect(
            screen.queryByTestId('dashboard-resize-ghost')
          ).not.toBeInTheDocument()
          expect(document.body).not.toHaveClass('is-dashboard-resizing')
          expect(grid.style.touchAction).toBe('')
          expect(setPointerCapture).not.toHaveBeenCalled()
          expect(raf.callbacks.size).toBe(0)
          expect(engine.style.transform).toBe('')
          expect(engine.style.willChange).toBe('')
          expect(engine.style.pointerEvents).toBe('')
          expect(engine.style.zIndex).toBe('')
        } finally {
          raf.restore()
        }
      }
    )

    it.each(['commit', 'cancel'] as const)(
      'falls back to window pointer events when capture throws on %s',
      (outcome) => {
        const raf = installAnimationFrameQueue()
        try {
          render(
            <DashboardGrid
              layout={layoutWithDisabledTiles(
                'speedLimit',
                'speedUp',
                'speedDown',
                'active',
                'tasks',
                'transfer'
              )}
              renderTile={renderTile}
            />
          )
          const grid = screen.getByTestId('dashboard-grid')
          vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
            makeRect({ width: 400, height: 384 })
          )
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const engine = screen.getByTestId('dashboard-tile-engine')
          const handle = getResizeHandle('engine')
          const setPointerCapture = vi.fn(() => {
            throw new Error('capture unavailable')
          })
          const releasePointerCapture = vi.fn()
          Object.defineProperties(handle, {
            setPointerCapture: {
              configurable: true,
              value: setPointerCapture,
            },
            releasePointerCapture: {
              configurable: true,
              value: releasePointerCapture,
            },
          })

          expect(() => {
            fireEvent.pointerDown(handle, {
              button: 0,
              clientX: 10,
              clientY: 10,
              isPrimary: true,
              pointerId: 29,
            })
          }).not.toThrow()
          expect(setPointerCapture).toHaveBeenCalledWith(29)
          expect(document.body).toHaveClass('is-dashboard-resizing')
          expect(grid.style.touchAction).toBe('none')

          fireEvent.pointerMove(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 29,
          })
          raf.runNext()
          expect(screen.getByTestId('dashboard-resize-ghost')).toHaveAttribute(
            'data-valid',
            'true'
          )

          if (outcome === 'commit') {
            fireEvent.pointerUp(window, {
              clientX: 150,
              clientY: 50,
              pointerId: 29,
            })
            expect(
              screen.getByText('engine-0,0-2x1-summary-wide-viewport:2x1')
            ).toBeInTheDocument()
          } else {
            fireEvent.pointerCancel(window, { pointerId: 29 })
            expect(
              screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
            ).toBeInTheDocument()
          }

          expect(
            screen.queryByTestId('dashboard-resize-ghost')
          ).not.toBeInTheDocument()
          expect(document.body).not.toHaveClass('is-dashboard-resizing')
          expect(grid.style.touchAction).toBe('')
          expect(releasePointerCapture).not.toHaveBeenCalled()
          expect(engine.style.transform).toBe('')
          expect(engine.style.willChange).toBe('')
          expect(engine.style.pointerEvents).toBe('')
          expect(engine.style.zIndex).toBe('')

          raf.runNext()
          expect(engine.style.transition).toBe('')
        } finally {
          raf.restore()
        }
      }
    )

    it('commits the final pointerup span without live-resizing the source tile', async () => {
      const raf = installAnimationFrameQueue()
      try {
        render(
          <DashboardGrid
            layout={layoutWithDisabledTiles(
              'speedLimit',
              'speedUp',
              'speedDown',
              'active',
              'tasks',
              'transfer'
            )}
            renderTile={renderTile}
          />
        )
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ width: 400, height: 384 })
        )

        fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
        const engine = screen.getByTestId('dashboard-tile-engine')
        const handle = getResizeHandle('engine')
        fireEvent.pointerDown(handle, {
          clientX: 10,
          clientY: 10,
          pointerId: 20,
        })
        fireEvent.pointerMove(window, {
          clientX: 20,
          clientY: 150,
          pointerId: 20,
        })
        raf.runNext()

        const ghost = screen.getByTestId('dashboard-resize-ghost')
        expect(ghost).toHaveAttribute('data-valid', 'true')
        expect(ghost.style.getPropertyValue('--dashboard-grid-column')).toBe(
          '1 / span 1'
        )
        expect(ghost.style.getPropertyValue('--dashboard-grid-row')).toBe(
          '1 / span 2'
        )
        expect(ghost).toHaveTextContent(/1\s*[×x]\s*2/)
        expect(
          screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
        ).toBeInTheDocument()
        expect(engine.style.getPropertyValue('--dashboard-grid-column')).toBe(
          '1 / span 1'
        )

        // The final pointerup intentionally lands on a different presentation
        // without running another frame. Commit must synchronously use these
        // final coordinates instead of the last rendered 1x2 ghost.
        fireEvent.pointerUp(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 20,
        })

        expect(
          screen.queryByTestId('dashboard-resize-ghost')
        ).not.toBeInTheDocument()
        expect(
          screen.getByText('engine-0,0-2x1-summary-wide-viewport:2x1')
        ).toBeInTheDocument()
        expect(engine.style.getPropertyValue('--dashboard-grid-column')).toBe(
          '1 / span 2'
        )
        expect(engine.style.getPropertyValue('--dashboard-grid-row')).toBe(
          '1 / span 1'
        )

        // Pointer resize must not replace the existing exact-size menu.
        await selectTileSize('engine', '1x1')
        expect(
          screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
        ).toBeInTheDocument()
      } finally {
        raf.restore()
      }
    })

    it('shows an invalid capacity ghost and rejects its release', () => {
      const raf = installAnimationFrameQueue()
      try {
        renderDefaultGrid()
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ width: 400, height: 384 })
        )

        fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
        const handle = getResizeHandle('engine')
        fireEvent.pointerDown(handle, {
          clientX: 10,
          clientY: 10,
          pointerId: 21,
        })
        fireEvent.pointerMove(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 21,
        })
        raf.runNext()

        const ghost = screen.getByTestId('dashboard-resize-ghost')
        expect(ghost).toHaveAttribute('data-valid', 'false')
        expect(ghost).toHaveClass('border-destructive')
        expect(ghost).toHaveTextContent(
          /Not enough space for this size|没有足够空间容纳此尺寸/i
        )
        expect(ghost.style.getPropertyValue('--dashboard-grid-column')).toBe(
          '1 / span 2'
        )
        expect(
          screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
        ).toBeInTheDocument()

        fireEvent.pointerUp(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 21,
        })

        expect(
          screen.queryByTestId('dashboard-resize-ghost')
        ).not.toBeInTheDocument()
        expect(
          screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
        ).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent(
          /Not enough space for this size|没有足够空间容纳此尺寸/i
        )
      } finally {
        raf.restore()
      }
    })

    it.each(['pointercancel', 'Escape'] as const)(
      'cancels pointer resize on %s and restores the interaction lifecycle',
      (cancelWith) => {
        const raf = installAnimationFrameQueue()
        try {
          render(
            <DashboardGrid
              layout={layoutWithDisabledTiles(
                'speedLimit',
                'speedUp',
                'speedDown',
                'active',
                'tasks',
                'transfer'
              )}
              renderTile={renderTile}
            />
          )
          const grid = screen.getByTestId('dashboard-grid')
          vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
            makeRect({ width: 400, height: 384 })
          )

          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const handle = getResizeHandle('engine')
          const setPointerCapture = vi.fn()
          const releasePointerCapture = vi.fn()
          Object.defineProperties(handle, {
            setPointerCapture: {
              configurable: true,
              value: setPointerCapture,
            },
            releasePointerCapture: {
              configurable: true,
              value: releasePointerCapture,
            },
          })
          fireEvent.pointerDown(handle, {
            clientX: 10,
            clientY: 10,
            pointerId: 22,
          })
          fireEvent.pointerMove(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 22,
          })
          raf.runNext()

          expect(screen.getByTestId('dashboard-resize-ghost')).toHaveAttribute(
            'data-valid',
            'true'
          )
          expect(grid.style.touchAction).toBe('none')
          expect(document.body).not.toHaveClass('is-dashboard-dragging')
          expect(setPointerCapture).toHaveBeenCalledWith(22)

          if (cancelWith === 'pointercancel') {
            fireEvent.pointerCancel(window, { pointerId: 22 })
          } else {
            fireEvent.keyDown(window, { key: 'Escape' })
          }

          expect(
            screen.queryByTestId('dashboard-resize-ghost')
          ).not.toBeInTheDocument()
          expect(
            screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
          ).toBeInTheDocument()
          expect(grid.style.touchAction).toBe('')
          expect(releasePointerCapture).toHaveBeenCalledWith(22)
        } finally {
          raf.restore()
        }
      }
    )

    it('coalesces pointermove frames and uses transforms without WAAPI', () => {
      const originalAnimate = HTMLElement.prototype.animate
      const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value: animate,
      })
      const raf = installAnimationFrameQueue()
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return gridTileRect(this)
        })

      try {
        render(
          <DashboardGrid
            layout={layoutWithDisabledTiles(
              'speedUp',
              'speedDown',
              'active',
              'tasks',
              'transfer'
            )}
            renderTile={renderTile}
          />
        )
        const grid = screen.getByTestId('dashboard-grid')
        rectSpy.mockImplementation(function (this: HTMLElement) {
          return this === grid
            ? makeRect({ width: 400, height: 384 })
            : gridTileRect(this)
        })

        fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
        const engine = screen.getByTestId('dashboard-tile-engine')
        const handle = getResizeHandle('engine')
        renderCounts.clear()
        fireEvent.pointerDown(handle, {
          clientX: 10,
          clientY: 10,
          pointerId: 23,
        })
        const rendersAfterStart = renderCounts.get('engine') ?? 0

        fireEvent.pointerMove(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 23,
        })
        fireEvent.pointerMove(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 23,
        })
        fireEvent.pointerMove(window, {
          clientX: 150,
          clientY: 50,
          pointerId: 23,
        })

        expect(raf.callbacks.size).toBe(1)
        expect(renderCounts.get('engine') ?? 0).toBe(rendersAfterStart)
        raf.runNext()

        expect(screen.getByTestId('dashboard-resize-ghost')).toHaveAttribute(
          'data-valid',
          'true'
        )
        expect(engine.style.transform).toBe('')
        expect(
          screen.getByTestId('dashboard-tile-speedLimit').style.transform
        ).toContain('translate3d')
        expect(animate).not.toHaveBeenCalled()

        fireEvent.pointerCancel(window, { pointerId: 23 })
        expect(animate).not.toHaveBeenCalled()
      } finally {
        rectSpy.mockRestore()
        raf.restore()
        if (originalAnimate) {
          Object.defineProperty(HTMLElement.prototype, 'animate', {
            configurable: true,
            value: originalAnimate,
          })
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, 'animate')
        }
      }
    })

    it('preserves an out-of-bounds snapped ghost at a bottom-right anchor', () => {
      const raf = installAnimationFrameQueue()
      const edgeLayout: DashboardLayoutSettings = {
        ...DEFAULT_DASHBOARD_LAYOUT,
        tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) =>
          tile.id === 'engine'
            ? {
                ...tile,
                enabled: true,
                x: 3,
                y: 2,
                w: 1,
                h: 1,
              }
            : { ...tile, enabled: false }
        ),
      }

      try {
        render(<DashboardGrid layout={edgeLayout} renderTile={renderTile} />)
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ width: 400, height: 384 })
        )
        const originalGetComputedStyle = window.getComputedStyle.bind(window)
        const styleSpy = vi
          .spyOn(window, 'getComputedStyle')
          .mockImplementation((element, pseudoElement) => {
            if (element !== grid) {
              return originalGetComputedStyle(
                element,
                pseudoElement ?? undefined
              )
            }
            return {
              gridTemplateColumns: '100px 100px 100px 100px',
              gridTemplateRows: '128px 128px 128px',
              columnGap: '0px',
              rowGap: '0px',
              borderLeftWidth: '0px',
              borderTopWidth: '0px',
              paddingLeft: '0px',
              paddingTop: '0px',
            } as CSSStyleDeclaration
          })

        try {
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const handle = getResizeHandle('engine')
          fireEvent.pointerDown(handle, {
            clientX: 350,
            clientY: 300,
            pointerId: 24,
          })
          fireEvent.pointerMove(window, {
            clientX: 450,
            clientY: 400,
            pointerId: 24,
          })
          raf.runNext()

          const ghost = screen.getByTestId('dashboard-resize-ghost')
          expect(ghost).toHaveAttribute('data-valid', 'false')
          expect(ghost).toHaveClass('fixed')
          expect(ghost).not.toHaveClass(
            'absolute',
            'inset-0',
            '@[560px]:[grid-column:var(--dashboard-grid-column)]',
            '@[560px]:[grid-row:var(--dashboard-grid-row)]'
          )
          expect(ghost.style.getPropertyValue('--dashboard-grid-column')).toBe(
            '4 / span 2'
          )
          expect(ghost.style.getPropertyValue('--dashboard-grid-row')).toBe(
            '3 / span 2'
          )
          expect(ghost).toHaveStyle({
            left: '300px',
            top: '256px',
            width: '200px',
            height: '256px',
          })
          expect(ghost).toHaveTextContent(/2\s*[×x]\s*2/)
          expect(
            screen.getByText('engine-3,2-1x1-compact-square-viewport:1x1')
          ).toBeInTheDocument()

          fireEvent.pointerUp(window, {
            clientX: 450,
            clientY: 400,
            pointerId: 24,
          })

          expect(
            screen.queryByTestId('dashboard-resize-ghost')
          ).not.toBeInTheDocument()
          expect(
            screen.getByText('engine-3,2-1x1-compact-square-viewport:1x1')
          ).toBeInTheDocument()
          expect(
            screen.getByTestId('dashboard-resize-announcement')
          ).toHaveTextContent(
            /Not enough space for this size|没有足够空间容纳此尺寸/i
          )
        } finally {
          styleSpy.mockRestore()
        }
      } finally {
        raf.restore()
      }
    })

    it('jumps displaced tiles to their target in one reduced-motion frame', () => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }))
      )
      const raf = installAnimationFrameQueue()
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return gridTileRect(this)
        })

      try {
        render(
          <DashboardGrid
            layout={layoutWithDisabledTiles(
              'speedUp',
              'speedDown',
              'active',
              'tasks',
              'transfer'
            )}
            renderTile={renderTile}
          />
        )
        const grid = screen.getByTestId('dashboard-grid')
        rectSpy.mockImplementation(function (this: HTMLElement) {
          return this === grid
            ? makeRect({ width: 400, height: 384 })
            : gridTileRect(this)
        })
        const originalGetComputedStyle = window.getComputedStyle.bind(window)
        const styleSpy = vi
          .spyOn(window, 'getComputedStyle')
          .mockImplementation((element, pseudoElement) => {
            if (element !== grid) {
              return originalGetComputedStyle(
                element,
                pseudoElement ?? undefined
              )
            }
            return {
              gridTemplateColumns: '100px 100px 100px 100px',
              gridTemplateRows: '128px 128px 128px',
              columnGap: '0px',
              rowGap: '0px',
              borderLeftWidth: '0px',
              borderTopWidth: '0px',
              paddingLeft: '0px',
              paddingTop: '0px',
            } as CSSStyleDeclaration
          })

        try {
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const handle = getResizeHandle('engine')
          fireEvent.pointerDown(handle, {
            clientX: 10,
            clientY: 10,
            pointerId: 25,
          })
          fireEvent.pointerMove(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 25,
          })

          expect(raf.callbacks.size).toBe(1)
          raf.runNext()

          expect(
            screen.getByTestId('dashboard-tile-speedLimit').style.transform
          ).toBe('translate3d(100px, 0px, 0)')
          expect(raf.callbacks.size).toBe(0)

          fireEvent.pointerCancel(window, { pointerId: 25 })
        } finally {
          styleSpy.mockRestore()
        }
      } finally {
        rectSpy.mockRestore()
        raf.restore()
      }
    })

    it.each(['narrow', 'unmount'] as const)(
      'cleans up an active resize on %s exit',
      async (exitWith) => {
        let resizeCallback: ResizeObserverCallback | undefined
        class TestResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', TestResizeObserver)
        const raf = installAnimationFrameQueue()

        try {
          const { unmount } = renderDefaultGrid()
          const grid = screen.getByTestId('dashboard-grid')
          vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
            makeRect({ width: 400, height: 384 })
          )
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const handle = getResizeHandle('engine')
          const setPointerCapture = vi.fn()
          const releasePointerCapture = vi.fn()
          Object.defineProperties(handle, {
            setPointerCapture: {
              configurable: true,
              value: setPointerCapture,
            },
            releasePointerCapture: {
              configurable: true,
              value: releasePointerCapture,
            },
          })
          fireEvent.pointerDown(handle, {
            clientX: 10,
            clientY: 10,
            pointerId: 26,
          })
          fireEvent.pointerMove(window, {
            clientX: 150,
            clientY: 50,
            pointerId: 26,
          })
          raf.runNext()

          expect(
            screen.getByTestId('dashboard-resize-ghost')
          ).toBeInTheDocument()
          expect(document.body).toHaveClass('is-dashboard-resizing')
          expect(grid.style.touchAction).toBe('none')
          expect(setPointerCapture).toHaveBeenCalledWith(26)

          if (exitWith === 'narrow') {
            act(() => {
              resizeCallback?.(
                [{ contentRect: { width: 559 } } as ResizeObserverEntry],
                {} as ResizeObserver
              )
            })
            await waitFor(() => {
              expect(
                screen.queryByTestId('dashboard-resize-ghost')
              ).not.toBeInTheDocument()
            })
            expect(grid.style.touchAction).toBe('')
            expect(
              screen.getByRole('button', { name: /Configure|配置/i })
            ).toBeDisabled()
          } else {
            unmount()
            expect(
              screen.queryByTestId('dashboard-resize-ghost')
            ).not.toBeInTheDocument()
          }

          expect(document.body).not.toHaveClass('is-dashboard-resizing')
          expect(releasePointerCapture).toHaveBeenCalledWith(26)
        } finally {
          raf.restore()
        }
      }
    )

    it('maps raw resize spans through computed tracks and gaps', () => {
      const raf = installAnimationFrameQueue()
      const trackedLayout: DashboardLayoutSettings = {
        ...DEFAULT_DASHBOARD_LAYOUT,
        tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) =>
          tile.id === 'speedUp'
            ? { ...tile, enabled: true, x: 0, y: 0, w: 1, h: 1 }
            : { ...tile, enabled: false }
        ),
      }

      try {
        render(<DashboardGrid layout={trackedLayout} renderTile={renderTile} />)
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ x: 20, y: 40, width: 450, height: 420 })
        )
        const originalGetComputedStyle = window.getComputedStyle.bind(window)
        const styleSpy = vi
          .spyOn(window, 'getComputedStyle')
          .mockImplementation((element, pseudoElement) => {
            if (element !== grid) {
              return originalGetComputedStyle(
                element,
                pseudoElement ?? undefined
              )
            }
            return {
              gridTemplateColumns: '80px 120px 90px 110px',
              gridTemplateRows: '100px 140px 120px',
              columnGap: '10px',
              rowGap: '12px',
              borderLeftWidth: '2px',
              borderTopWidth: '3px',
              paddingLeft: '8px',
              paddingTop: '7px',
            } as CSSStyleDeclaration
          })

        try {
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const handle = getResizeHandle('speedUp')
          fireEvent.pointerDown(handle, {
            clientX: 40,
            clientY: 60,
            pointerId: 27,
          })
          fireEvent.pointerMove(window, {
            clientX: 260,
            clientY: 200,
            pointerId: 27,
          })
          raf.runNext()

          const ghost = screen.getByTestId('dashboard-resize-ghost')
          expect(ghost).toHaveAttribute('data-valid', 'true')
          expect(ghost.style.getPropertyValue('--dashboard-grid-column')).toBe(
            '1 / span 3'
          )
          expect(ghost.style.getPropertyValue('--dashboard-grid-row')).toBe(
            '1 / span 2'
          )
          expect(ghost).toHaveTextContent(/3\s*[×x]\s*2/)
          expect(
            screen.getByText('speedUp-0,0-1x1-compact-square-viewport:1x1')
          ).toBeInTheDocument()

          fireEvent.pointerCancel(window, { pointerId: 27 })
        } finally {
          styleSpy.mockRestore()
        }
      } finally {
        raf.restore()
      }
    })
  })

  it('moves a tile by dragging its handle across grid cells', () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('tasks', 'transfer')}
        renderTile={renderTile}
      />
    )
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 384,
      width: 400,
      height: 384,
      toJSON: () => ({}),
    })

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.pointerDown(
      within(screen.getByTestId('dashboard-tile-engine')).getByRole('button', {
        name: /Drag tile|拖拽/i,
      })
    )
    fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
    fireEvent.pointerUp(window)

    expect(
      screen.getByText('engine-2,1-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
  })

  it.each([
    ['without moving the pointer', 0, 0],
    ['after moving one column track', 100, 1],
  ] as const)(
    'preserves a large tile grab offset %s',
    (_case, deltaX, expectedX) => {
      const raf = installAnimationFrameQueue()
      const tasksOnlyLayout: DashboardLayoutSettings = {
        ...DEFAULT_DASHBOARD_LAYOUT,
        tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) =>
          tile.id === 'tasks'
            ? { ...tile, enabled: true, x: 0, y: 0, w: 2, h: 2 }
            : { ...tile, enabled: false }
        ),
      }
      const originalGetComputedStyle = window.getComputedStyle.bind(window)

      try {
        render(
          <DashboardGrid layout={tasksOnlyLayout} renderTile={renderTile} />
        )
        const grid = screen.getByTestId('dashboard-grid')
        vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
          makeRect({ x: 40, y: 20, width: 400, height: 384 })
        )
        const styleSpy = vi
          .spyOn(window, 'getComputedStyle')
          .mockImplementation((element, pseudoElement) => {
            if (element !== grid) {
              return originalGetComputedStyle(
                element,
                pseudoElement ?? undefined
              )
            }
            return {
              gridTemplateColumns: '100px 100px 100px 100px',
              gridTemplateRows: '128px 128px 128px',
              columnGap: '0px',
              rowGap: '0px',
              borderLeftWidth: '0px',
              borderTopWidth: '0px',
              paddingLeft: '0px',
              paddingTop: '0px',
            } as CSSStyleDeclaration
          })

        try {
          fireEvent.click(
            screen.getByRole('button', { name: /Configure|配置/i })
          )
          const tasks = screen.getByTestId('dashboard-tile-tasks')
          vi.spyOn(tasks, 'getBoundingClientRect').mockReturnValue(
            makeRect({ x: 40, y: 20, width: 200, height: 256 })
          )
          const dragHandle = within(tasks).getByRole('button', {
            name: /Drag tile|拖拽/i,
          })
          const grabX = 230
          const grabY = 30

          fireEvent.pointerDown(dragHandle, {
            button: 0,
            clientX: grabX,
            clientY: grabY,
            pointerId: 30,
          })
          if (deltaX !== 0) {
            fireEvent.pointerMove(window, {
              clientX: grabX + deltaX,
              clientY: grabY,
              pointerId: 30,
            })
          }
          raf.runNext()

          expect(tasks.style.transform).toBe(
            `translate3d(${deltaX}px, 0px, 0) scale(1.03)`
          )
          expect(
            screen.getByText('tasks-0,0-2x2-detailed-square-viewport:2x2')
          ).toBeInTheDocument()

          fireEvent.pointerUp(window, {
            clientX: grabX + deltaX,
            clientY: grabY,
            pointerId: 30,
          })

          expect(
            screen.getByText(
              `tasks-${expectedX},0-2x2-detailed-square-viewport:2x2`
            )
          ).toBeInTheDocument()
        } finally {
          styleSpy.mockRestore()
        }
      } finally {
        raf.restore()
      }
    }
  )

  it('rejects drops that would push a visible tile out of the 4x3 canvas', () => {
    render(
      <DashboardGrid
        layout={{
          ...DEFAULT_DASHBOARD_LAYOUT,
          tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => {
            if (tile.id === 'tasks') return { ...tile, enabled: true }
            if (tile.id === 'transfer') return { ...tile, enabled: false }
            if (tile.id === 'activity') return { ...tile, enabled: false }
            return tile
          }),
        }}
        renderTile={renderTile}
      />
    )
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      makeRect({ width: 400, height: 384 })
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.pointerDown(
      within(screen.getByTestId('dashboard-tile-engine')).getByRole('button', {
        name: /Drag tile|拖拽/i,
      })
    )
    fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
    fireEvent.pointerUp(window)

    expect(
      screen.getByText('engine-0,0-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-tile-tasks')).toHaveAttribute(
      'data-enabled',
      'true'
    )
  })

  it('keeps pointermove updates out of the React render loop', () => {
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(performance.now())
        return 1
      })
    const cancelRafSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
    renderDefaultGrid()
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      makeRect({ width: 400, height: 384 })
    )
    const engine = screen.getByTestId('dashboard-tile-engine')
    vi.spyOn(engine, 'getBoundingClientRect').mockReturnValue(
      makeRect({ x: 0, y: 0, width: 100, height: 128 })
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    renderCounts.clear()
    const dragHandle = within(engine).getByRole('button', {
      name: /Drag tile|拖拽/i,
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(dragHandle, {
      setPointerCapture: {
        configurable: true,
        value: setPointerCapture,
      },
      releasePointerCapture: {
        configurable: true,
        value: releasePointerCapture,
      },
    })
    fireEvent.pointerDown(dragHandle, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    })

    fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 280 })
    fireEvent.pointerMove(window, { clientX: 180, clientY: 40 })

    expect(renderCounts.get('engine') ?? 0).toBeLessThanOrEqual(1)
    expect(engine.style.transform).toContain('translate3d')
    expect(document.body).toHaveClass('is-dashboard-dragging')
    expect(grid.style.touchAction).toBe('none')
    expect(setPointerCapture).toHaveBeenCalledWith(1)

    fireEvent.pointerCancel(window, { pointerId: 1 })

    expect(document.body).not.toHaveClass('is-dashboard-dragging')
    expect(grid.style.touchAction).toBe('')
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    rafSpy.mockRestore()
    cancelRafSpy.mockRestore()
  })

  it('maps drag rows against rendered track sizes, not the 8rem floor', () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('active', 'transfer')}
        renderTile={renderTile}
      />
    )
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      makeRect({ width: 448, height: 932 })
    )
    // Simulate stretched 1fr rows (~300px) the way a real viewport renders
    // them. With the old fixed-128px math, clientY=450 would land on y=3.
    const originalGetComputedStyle = window.getComputedStyle.bind(window)
    const styleSpy = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element, pseudoElement) => {
        if (element !== grid) {
          return originalGetComputedStyle(element, pseudoElement ?? undefined)
        }
        return {
          gridTemplateColumns: '100px 100px 100px 100px',
          gridTemplateRows: '300px 300px 300px',
          columnGap: '16px',
          rowGap: '16px',
          borderLeftWidth: '0px',
          borderTopWidth: '0px',
          paddingLeft: '0px',
          paddingTop: '0px',
        } as CSSStyleDeclaration
      })

    try {
      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
      fireEvent.pointerDown(
        within(screen.getByTestId('dashboard-tile-speedLimit')).getByRole(
          'button',
          { name: /Drag tile|拖拽/i }
        )
      )
      fireEvent.pointerMove(window, { clientX: 50, clientY: 450 })
      fireEvent.pointerUp(window)

      // engine still occupies (0,0), so the release pass cannot compact the
      // dropped tile above the mapped row — it stays exactly at y=1.
      expect(
        screen.getByText('speedLimit-0,1-1x1-compact-square-viewport:1x1')
      ).toBeInTheDocument()
    } finally {
      styleSpy.mockRestore()
    }
  })

  it('rejects a drop below the fixed canvas', () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('transfer')}
        renderTile={renderTile}
      />
    )
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      makeRect({ width: 400, height: 384 })
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.pointerDown(
      within(screen.getByTestId('dashboard-tile-speedUp')).getByRole('button', {
        name: /Drag tile|拖拽/i,
      })
    )
    fireEvent.pointerMove(window, { clientX: 20, clientY: 400 })
    fireEvent.pointerUp(window)

    // The fixed 4x3 canvas rejects row 3. A failed move keeps the entire
    // draft unchanged instead of clamping or partially repacking it.
    expect(
      screen.getByText('speedUp-2,0-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
  })

  it('keeps a dropped tile in a lower empty grid cell', () => {
    render(
      <DashboardGrid
        layout={layoutWithDisabledTiles('active', 'transfer', 'tasks')}
        renderTile={renderTile}
      />
    )
    const grid = screen.getByTestId('dashboard-grid')
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(
      makeRect({ width: 400, height: 384 })
    )

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    fireEvent.pointerDown(
      within(screen.getByTestId('dashboard-tile-engine')).getByRole('button', {
        name: /Drag tile|拖拽/i,
      })
    )
    fireEvent.pointerMove(window, { clientX: 20, clientY: 300 })
    fireEvent.pointerUp(window)

    expect(
      screen.getByText('engine-0,2-1x1-compact-square-viewport:1x1')
    ).toBeInTheDocument()
  })

  it('previews drag displacement with inline transforms instead of WAAPI', () => {
    const originalAnimate = HTMLElement.prototype.animate
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(performance.now())
        return 1
      })
    const cancelRafSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return gridTileRect(this)
      })

    try {
      render(
        <DashboardGrid
          layout={layoutWithDisabledTiles('tasks')}
          renderTile={renderTile}
        />
      )
      const grid = screen.getByTestId('dashboard-grid')
      rectSpy.mockImplementation(function (this: HTMLElement) {
        return this === grid
          ? makeRect({ width: 400, height: 384 })
          : gridTileRect(this)
      })

      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
      fireEvent.pointerDown(
        within(screen.getByTestId('dashboard-tile-engine')).getByRole(
          'button',
          {
            name: /Drag tile|拖拽/i,
          }
        )
      )
      fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 20, clientY: 280 })

      const transformedTiles = screen
        .getAllByTestId(/^dashboard-tile-/)
        .filter(
          (element) =>
            element.dataset.dashboardTileId !== 'engine' &&
            element.style.transform.includes('translate3d')
        )
      expect(transformedTiles.length).toBeGreaterThan(0)
      expect(animate).not.toHaveBeenCalled()
    } finally {
      rectSpy.mockRestore()
      rafSpy.mockRestore()
      cancelRafSpy.mockRestore()
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', {
          configurable: true,
          value: originalAnimate,
        })
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'animate')
      }
    }
  })

  it('clears displaced tile transforms before restoring CSS transitions', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      })
    const cancelRafSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        rafCallbacks.delete(id)
      })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return gridTileRect(this)
      })

    try {
      render(
        <DashboardGrid
          layout={layoutWithDisabledTiles('tasks')}
          renderTile={renderTile}
        />
      )
      const grid = screen.getByTestId('dashboard-grid')
      rectSpy.mockImplementation(function (this: HTMLElement) {
        return this === grid
          ? makeRect({ width: 400, height: 384 })
          : gridTileRect(this)
      })

      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
      fireEvent.pointerDown(
        within(screen.getByTestId('dashboard-tile-engine')).getByRole(
          'button',
          {
            name: /Drag tile|拖拽/i,
          }
        )
      )
      const firstFrame = rafCallbacks.get(1)
      rafCallbacks.delete(1)
      firstFrame?.(performance.now())

      fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
      expect([...rafCallbacks.keys()]).toEqual([2])
      const moveFrame = rafCallbacks.get(2)
      rafCallbacks.delete(2)
      moveFrame?.(performance.now())
      const displaced = screen.getByTestId('dashboard-tile-transfer')
      expect(displaced.style.transform).toContain('translate3d')

      fireEvent.pointerUp(window)

      expect(displaced.style.transform).toBe('')
      expect(displaced.style.transition).toBe('none')

      const restoreFrame = [...rafCallbacks.values()].at(-1)
      restoreFrame?.(performance.now())

      expect(displaced.style.transition).toBe('')
    } finally {
      rectSpy.mockRestore()
      rafSpy.mockRestore()
      cancelRafSpy.mockRestore()
    }
  })

  it('does not FLIP-animate the dropped tile after release', () => {
    const animatedTileIds: Array<string | undefined> = []
    const originalAnimate = HTMLElement.prototype.animate
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        animatedTileIds.push(this.dataset.dashboardTileId)
        return { cancel: vi.fn() } as unknown as Animation
      }),
    })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return gridTileRect(this)
      })

    try {
      render(
        <DashboardGrid
          layout={layoutWithDisabledTiles('tasks', 'transfer')}
          renderTile={renderTile}
        />
      )
      const grid = screen.getByTestId('dashboard-grid')
      rectSpy.mockImplementation(function (this: HTMLElement) {
        return this === grid
          ? makeRect({ width: 400, height: 384 })
          : gridTileRect(this)
      })

      fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
      fireEvent.pointerDown(
        within(screen.getByTestId('dashboard-tile-engine')).getByRole(
          'button',
          {
            name: /Drag tile|拖拽/i,
          }
        )
      )
      fireEvent.pointerMove(window, { clientX: 260, clientY: 150 })
      fireEvent.pointerUp(window)

      expect(
        screen.getByText('engine-2,1-1x1-compact-square-viewport:1x1')
      ).toBeInTheDocument()
      expect(animatedTileIds).not.toContain('engine')
    } finally {
      rectSpy.mockRestore()
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', {
          configurable: true,
          value: originalAnimate,
        })
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'animate')
      }
    }
  })

  it('does not FLIP-animate when only the container resizes', () => {
    // A CSS-only container resize (sidebar collapse/expand, window resize)
    // moves every tile's pixels without changing its grid coordinates. The
    // FLIP must not slide tiles on the next unrelated re-render (the idle 10s
    // stats tick), or the board visibly flickers seconds after the resize.
    let colW = 100
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const column = Number.parseInt(
          this.style.getPropertyValue('--dashboard-grid-column'),
          10
        )
        const row = Number.parseInt(
          this.style.getPropertyValue('--dashboard-grid-row'),
          10
        )
        return makeRect({
          x: (Number.isNaN(column) ? 0 : column - 1) * colW,
          y: (Number.isNaN(row) ? 0 : row - 1) * 128,
        })
      })

    try {
      const { rerender } = render(
        <DashboardGrid
          layout={DEFAULT_DASHBOARD_LAYOUT}
          renderTile={renderTile}
        />
      )
      expect(animate).not.toHaveBeenCalled()

      // Container grows: column width 100 -> 160. No React re-render here.
      colW = 160

      // An unrelated re-render arrives (idle StatsUpdated tick). The tile
      // layout is byte-for-byte identical; only the measured pixels moved.
      rerender(
        <DashboardGrid
          layout={DEFAULT_DASHBOARD_LAYOUT}
          renderTile={renderTile}
          className="unrelated-rerender"
        />
      )

      expect(animate).not.toHaveBeenCalled()
    } finally {
      rectSpy.mockRestore()
      Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    }
  })

  it('does not FLIP-animate when the tile layout changes', () => {
    // Dashboard drag uses its own rAF/transform preview while dragging.
    // Once layout state changes, tiles should snap to CSS grid positions
    // without a second WAAPI FLIP layer.
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return gridTileRect(this)
      })

    try {
      const { rerender } = render(
        <DashboardGrid
          layout={DEFAULT_DASHBOARD_LAYOUT}
          renderTile={renderTile}
        />
      )
      expect(animate).not.toHaveBeenCalled()

      rerender(
        <DashboardGrid
          layout={{
            ...DEFAULT_DASHBOARD_LAYOUT,
            tiles: DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) =>
              tile.id === 'engine' ? { ...tile, x: 2, y: 1 } : { ...tile }
            ),
          }}
          renderTile={renderTile}
        />
      )

      expect(animate).not.toHaveBeenCalled()
    } finally {
      rectSpy.mockRestore()
      Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    }
  })
})
