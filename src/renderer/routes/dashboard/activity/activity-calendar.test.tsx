import '@renderer/lib/i18n'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { TaskActivitySnapshot } from '@shared/types/task-activity'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_TOOLTIP_CLOSE_GRACE_MS,
  ACTIVITY_TOOLTIP_OPEN_DELAY_MS,
  ACTIVITY_TOOLTIP_SKIP_DELAY_MS,
  ActivityCalendar,
  drawActivityCanvas,
} from './activity-calendar'
import { selectActivityGeometry } from './activity-calendar-model'

const themeHarness = vi.hoisted(() => ({
  resolvedTheme: 'light' as 'light' | 'dark',
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeHarness.resolvedTheme }),
}))

interface TestMediaQuery {
  query: string
  listeners: Set<(event: MediaQueryListEvent) => void>
}

interface TestResizeObserverRecord {
  callback: ResizeObserverCallback
  targets: Set<Element>
}

const calendarSize = { width: 180, height: 80 }
const resizeObservers: TestResizeObserverRecord[] = []
const mediaQueries: TestMediaQuery[] = []
const frameQueue = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let canvasContext: {
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  fillRect: ReturnType<typeof vi.fn>
  roundRect: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  strokeRect: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  moveTo: ReturnType<typeof vi.fn>
  lineTo: ReturnType<typeof vi.fn>
  stroke: ReturnType<typeof vi.fn>
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineCap: CanvasLineCap
}
let filledStyles: string[] = []
let originalClientWidth: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined
let originalBoundingRect: typeof Element.prototype.getBoundingClientRect
let originalDevicePixelRatio: PropertyDescriptor | undefined
let mutationObserverConstructionCount = 0

function activitySnapshot(
  overrides: Partial<TaskActivitySnapshot> = {}
): TaskActivitySnapshot {
  return {
    generation: 'calendar-test',
    revision: 1,
    coverage: {
      trackingStartedAt: new Date(2020, 0, 1).getTime(),
      coverageGapAt: null,
    },
    days: [
      {
        dateKey: '2026-07-29',
        submitted: 3,
        downloadCompleted: 2,
        recoveredDownloadCompleted: 1,
      },
    ],
    ...overrides,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    for (let pass = 0; pass < 10 && frameQueue.size > 0; pass += 1) {
      const callbacks = [...frameQueue.values()]
      frameQueue.clear()
      for (const callback of callbacks) callback(performance.now())
    }
  })
}

async function advanceTimersByTime(milliseconds: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds)
  })
}

function emitResize(target: Element, width: number, height: number): void {
  calendarSize.width = width
  calendarSize.height = height
  for (const observer of resizeObservers) {
    if (!observer.targets.has(target)) continue
    observer.callback(
      [
        {
          target,
          contentRect: {
            width,
            height,
            x: 0,
            y: 0,
            top: 0,
            right: width,
            bottom: height,
            left: 0,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry,
      ],
      {} as ResizeObserver
    )
  }
}

function changeDpr(nextDpr: number): void {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: nextDpr,
  })
  for (const query of [...mediaQueries]) {
    for (const listener of [...query.listeners]) {
      listener({
        matches: false,
        media: query.query,
      } as MediaQueryListEvent)
    }
  }
}

beforeEach(() => {
  calendarSize.width = 180
  calendarSize.height = 80
  resizeObservers.length = 0
  mediaQueries.length = 0
  frameQueue.clear()
  nextFrameId = 1
  themeHarness.resolvedTheme = 'light'
  mutationObserverConstructionCount = 0
  filledStyles = []

  canvasContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(() => {
      filledStyles.push(canvasContext.fillStyle)
    }),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
  }

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => canvasContext as unknown as CanvasRenderingContext2D
  )

  originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth'
  )
  originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight'
  )
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === 'activity-calendar'
        ? calendarSize.width
        : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === 'activity-calendar'
        ? calendarSize.height
        : 0
    },
  })

  originalBoundingRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement
    const width =
      element.dataset.testid === 'activity-calendar'
        ? calendarSize.width
        : Number.parseFloat(element.style.width) || 0
    const height =
      element.dataset.testid === 'activity-calendar'
        ? calendarSize.height
        : Number.parseFloat(element.style.height) || 0
    return {
      x: 0,
      y: 0,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      width,
      height,
      toJSON: () => ({}),
    }
  }

  class TestResizeObserver implements ResizeObserver {
    readonly #record: TestResizeObserverRecord

    constructor(callback: ResizeObserverCallback) {
      this.#record = { callback, targets: new Set() }
      resizeObservers.push(this.#record)
    }

    observe(target: Element): void {
      this.#record.targets.add(target)
    }

    unobserve(target: Element): void {
      this.#record.targets.delete(target)
    }

    disconnect(): void {
      this.#record.targets.clear()
    }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal(
    'MutationObserver',
    class TestMutationObserver implements MutationObserver {
      constructor(callback: MutationCallback) {
        mutationObserverConstructionCount += 1
        void callback
      }

      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] {
        return []
      }
    }
  )

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId
      nextFrameId += 1
      frameQueue.set(id, callback)
      return id
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      frameQueue.delete(id)
    })
  )

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const record: TestMediaQuery = {
        query,
        listeners: new Set(),
      }
      mediaQueries.push(record)
      return {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void
        ) => record.listeners.add(listener),
        removeEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void
        ) => record.listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList
    })
  )

  originalDevicePixelRatio = Object.getOwnPropertyDescriptor(
    window,
    'devicePixelRatio'
  )
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Element.prototype.getBoundingClientRect = originalBoundingRect
  if (originalClientWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      'clientWidth',
      originalClientWidth
    )
  }
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'clientHeight',
      originalClientHeight
    )
  }
  if (originalDevicePixelRatio) {
    Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatio)
  }
})

describe('ActivityCalendar', () => {
  it('keeps the documented Tooltip timing contract', () => {
    expect(ACTIVITY_TOOLTIP_OPEN_DELAY_MS).toBe(300)
    expect(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS).toBe(100)
    expect(ACTIVITY_TOOLTIP_SKIP_DELAY_MS).toBe(300)
  })

  it('draws one Canvas and exposes a valid virtual grid hierarchy', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )

    await flushFrames()

    expect(
      document.querySelectorAll('[data-testid="activity-canvas"]')
    ).toHaveLength(1)
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d')
    expect(canvasContext.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(canvasContext.roundRect).toHaveBeenCalled()
    expect(canvasContext.fill).toHaveBeenCalled()

    const grid = screen.getByRole('grid')
    const row = within(grid).getByRole('row')
    const cell = within(row).getByRole('gridcell')
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(1)
    expect(row.getAttribute('aria-rowindex')).toBe('4')
    expect(cell.getAttribute('aria-rowindex')).toBe('4')
    expect(cell.getAttribute('aria-colindex')).toBe('13')
    expect(grid.getAttribute('aria-activedescendant')).toBe(cell.id)
  })

  it('moves the DOM overlays without repainting for hover or keyboard', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const drawCalls = canvasContext.roundRect.mock.calls.length

    fireEvent.pointerEnter(grid, {
      clientX: geometry.gridLeft + 12 * geometry.stride + 1,
      clientY: geometry.gridTop + 3 * geometry.stride + 1,
      pointerType: 'mouse',
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('2 completed')
    expect(tooltip.textContent).toContain('1 recovered')
    expect(canvasContext.roundRect).toHaveBeenCalledTimes(drawCalls)

    fireEvent.focus(grid)
    fireEvent.keyDown(grid, { key: 'ArrowLeft' })
    const focusOverlay = screen.getByTestId('activity-focus-overlay')
    expect(focusOverlay.classList).toContain('box-border')
    expect(focusOverlay.classList).toContain('rounded-[2px]')
    expect(focusOverlay.classList).toContain('border')
    expect(focusOverlay.classList).toContain('border-ring')
    expect(focusOverlay.classList).not.toContain('ring-inset')
    expect(focusOverlay.classList).not.toContain('transition-[left,top]')
    expect(canvasContext.roundRect).toHaveBeenCalledTimes(drawCalls)

    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not add resize observers while retargeting an open Tooltip', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const observerCountAfterMount = resizeObservers.length
    expect(observerCountAfterMount).toBeGreaterThan(0)
    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const point = (column: number) => ({
      clientX: geometry.gridLeft + column * geometry.stride + 1,
      clientY: geometry.gridTop + 1,
    })

    fireEvent.pointerMove(grid, point(0))
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).not.toBeNull()
    expect(resizeObservers).toHaveLength(observerCountAfterMount)

    for (let column = 1; column < geometry.weeks; column += 1) {
      fireEvent.pointerMove(grid, point(column))
    }
    expect(resizeObservers).toHaveLength(observerCountAfterMount)

    view.unmount()
    expect(
      resizeObservers.every((observer) => observer.targets.size === 0)
    ).toBe(true)
  })

  it('keeps the rounded focus border inside a grid that touches every edge', async () => {
    calendarSize.width = 103
    calendarSize.height = 55
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 7, 1, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    fireEvent.focus(grid)
    const overlay = screen.getByTestId('activity-focus-overlay')
    const position = () => ({
      left: Number.parseFloat(overlay.style.left),
      top: Number.parseFloat(overlay.style.top),
      width: Number.parseFloat(overlay.style.width),
      height: Number.parseFloat(overlay.style.height),
    })

    expect(overlay.classList).toContain('box-border')
    expect(overlay.classList).toContain('rounded-[2px]')
    expect(overlay.classList).toContain('border')
    expect(overlay.classList).toContain('border-ring')
    expect(overlay.classList).not.toContain('ring-inset')
    expect(overlay.classList).not.toContain('ring-offset-1')
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe(
      '13'
    )
    expect(screen.getByRole('gridcell').getAttribute('aria-rowindex')).toBe('7')
    let edge = position()
    expect(edge.left + edge.width).toBe(103)
    expect(edge.top + edge.height).toBe(55)

    fireEvent.keyDown(grid, { key: 'Home', ctrlKey: true })
    edge = position()
    expect(edge.left).toBe(0)
    expect(edge.top).toBe(0)

    fireEvent.keyDown(grid, { key: 'End', ctrlKey: true })
    edge = position()
    expect(edge.left + edge.width).toBe(103)
    expect(edge.top + edge.height).toBe(55)

    emitResize(grid, 54, 48)
    await flushFrames()
    const emergencyOverlay = screen.getByTestId('activity-focus-overlay')
    const emergencyPosition = {
      left: Number.parseFloat(emergencyOverlay.style.left),
      top: Number.parseFloat(emergencyOverlay.style.top),
      width: Number.parseFloat(emergencyOverlay.style.width),
      height: Number.parseFloat(emergencyOverlay.style.height),
    }
    expect(grid.getAttribute('aria-colcount')).toBe('9')
    expect(emergencyOverlay.classList).toContain('border')
    expect(emergencyOverlay.classList).toContain('border-ring')
    expect(emergencyOverlay.classList).not.toContain('ring-1')
    expect(emergencyOverlay.classList).not.toContain('ring-offset-1')
    const emergencyGeometry = selectActivityGeometry({
      width: 54,
      height: 48,
      contentLevel: 'compact',
    })
    if (!emergencyGeometry) throw new Error('Missing emergency geometry')
    expect(emergencyPosition.left + emergencyPosition.width).toBe(
      emergencyGeometry.gridLeft + emergencyGeometry.gridWidth
    )
    expect(emergencyPosition.top + emergencyPosition.height).toBe(
      emergencyGeometry.gridTop + emergencyGeometry.gridHeight
    )
    expect(
      emergencyPosition.left + emergencyPosition.width
    ).toBeLessThanOrEqual(54)
    expect(
      emergencyPosition.top + emergencyPosition.height
    ).toBeLessThanOrEqual(48)
  })

  it('uses stable-cell dwell, gap grace, and a warm no-animation retarget', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    vi.setSystemTime(new Date(2026, 6, 29, 12))
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const point = (column: number) => ({
      clientX: geometry.gridLeft + column * geometry.stride + 1,
      clientY: geometry.gridTop + 1,
    })

    fireEvent.pointerMove(grid, point(0))
    await advanceTimersByTime(200)
    fireEvent.pointerMove(grid, point(1))
    await advanceTimersByTime(100)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS - 101)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(1)

    const firstTooltip = screen.getByRole('tooltip')
    const firstText = firstTooltip.textContent
    expect(firstTooltip.classList.contains('animate-none')).toBe(true)
    expect(firstTooltip.classList.contains('data-open:animate-none')).toBe(true)
    expect(firstTooltip.classList.contains('transition-none')).toBe(true)

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.stride + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS - 1)
    expect(screen.getByRole('tooltip')).toBe(firstTooltip)

    fireEvent.pointerMove(grid, point(2))
    expect(screen.getByRole('tooltip')).toBe(firstTooltip)
    expect(screen.getByRole('tooltip').textContent).not.toBe(firstText)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS + 1)
    expect(screen.getByRole('tooltip')).toBe(firstTooltip)

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 2 * geometry.stride + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()

    await advanceTimersByTime(ACTIVITY_TOOLTIP_SKIP_DELAY_MS - 1)
    fireEvent.pointerMove(grid, point(3))
    expect(screen.getByRole('tooltip')).not.toBeNull()
    expect(screen.getByRole('tooltip').classList.contains('animate-none')).toBe(
      true
    )

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 3 * geometry.stride + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_SKIP_DELAY_MS)
    fireEvent.pointerMove(grid, point(4))
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).not.toBeNull()

    fireEvent.pointerLeave(grid)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerMove(grid, point(5))
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(200)
    fireEvent.pointerMove(grid, point(5))
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS - 200)
    expect(screen.getByRole('tooltip')).not.toBeNull()

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 12 * geometry.stride + 1,
      clientY: geometry.gridTop + 4 * geometry.stride + 1,
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerMove(grid, point(6))
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).not.toBeNull()

    const verticalGapTooltip = screen.getByRole('tooltip')
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 6 * geometry.stride + 1,
      clientY: geometry.gridTop + geometry.cellSize,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS - 1)
    expect(screen.getByRole('tooltip')).toBe(verticalGapTooltip)
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 6 * geometry.stride + 1,
      clientY: geometry.gridTop + geometry.stride + 1,
    })
    expect(screen.getByRole('tooltip')).toBe(verticalGapTooltip)

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.gridWidth + 1,
      clientY: geometry.gridTop + geometry.cellSize,
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerMove(grid, point(7))
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).not.toBeNull()
  })

  it('keeps mouse hover live after activation and follows the latest input mode', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const point = (column: number) => ({
      clientX: geometry.gridLeft + column * geometry.stride + 1,
      clientY: geometry.gridTop + 1,
      pointerType: 'mouse',
    })

    fireEvent.pointerDown(grid, point(0))
    expect(document.activeElement).toBe(grid)
    const tooltip = screen.getByRole('tooltip')
    const clickedText = tooltip.textContent
    const activeCell = screen.getByRole('gridcell')
    expect(activeCell.getAttribute('aria-colindex')).toBe('1')
    expect(activeCell.getAttribute('aria-rowindex')).toBe('1')
    const focusOverlay = screen.getByTestId('activity-focus-overlay')
    const initialFocusPosition = {
      left: focusOverlay.style.left,
      top: focusOverlay.style.top,
    }
    const tooltipAnchor = screen.getByTestId('activity-tooltip-anchor')
    const clickedAnchorLeft = tooltipAnchor.style.left

    fireEvent.pointerDown(grid, point(0))
    expect(screen.getByRole('tooltip')).toBe(tooltip)

    fireEvent.pointerMove(grid, point(2))
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    expect(screen.getByRole('tooltip').textContent).not.toBe(clickedText)
    expect(activeCell.getAttribute('aria-colindex')).toBe('1')
    expect(activeCell.getAttribute('aria-rowindex')).toBe('1')
    expect(focusOverlay.style.left).toBe(initialFocusPosition.left)
    expect(focusOverlay.style.top).toBe(initialFocusPosition.top)
    expect(tooltipAnchor.style.left).not.toBe(clickedAnchorLeft)

    const pointerText = screen.getByRole('tooltip').textContent
    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    expect(screen.getByRole('tooltip').textContent).not.toBe(pointerText)
    expect(activeCell.getAttribute('aria-colindex')).toBe('2')
    expect(activeCell.getAttribute('aria-rowindex')).toBe('1')
    expect(screen.getByTestId('activity-focus-overlay')).not.toBeNull()

    const keyboardText = screen.getByRole('tooltip').textContent
    const keyboardAnchorPosition = {
      left: tooltipAnchor.style.left,
      top: tooltipAnchor.style.top,
    }
    const keyboardFocusPosition = {
      left: focusOverlay.style.left,
      top: focusOverlay.style.top,
    }
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.stride + geometry.cellSize,
      clientY: geometry.gridTop + 1,
      pointerType: 'mouse',
    })
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.gridWidth + 1,
      clientY: geometry.gridTop,
      pointerType: 'mouse',
    })
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    expect(screen.getByRole('tooltip').textContent).toBe(keyboardText)
    expect(activeCell.getAttribute('aria-colindex')).toBe('2')
    expect(tooltipAnchor.style.left).toBe(keyboardAnchorPosition.left)
    expect(tooltipAnchor.style.top).toBe(keyboardAnchorPosition.top)
    expect(focusOverlay.style.left).toBe(keyboardFocusPosition.left)
    expect(focusOverlay.style.top).toBe(keyboardFocusPosition.top)

    fireEvent.pointerMove(grid, point(3))
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    expect(screen.getByRole('tooltip').textContent).not.toBe(keyboardText)
    expect(activeCell.getAttribute('aria-colindex')).toBe('2')
    expect(activeCell.getAttribute('aria-rowindex')).toBe('1')
    expect(focusOverlay.style.left).toBe(keyboardFocusPosition.left)
    expect(focusOverlay.style.top).toBe(keyboardFocusPosition.top)

    fireEvent.pointerLeave(grid, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement).toBe(grid)
  })

  it('hit-tests direct touch activation and ignores gaps and future cells', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')

    const grid = screen.getByRole('grid')
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe(
      '13'
    )

    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
      pointerType: 'touch',
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // Touch and pen activation do not require a preceding pointermove, so the
    // pointerdown coordinates must select the cell directly.
    fireEvent.pointerDown(grid, {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
      pointerType: 'touch',
    })

    expect(document.activeElement).toBe(grid)
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe('1')
    expect(screen.getByRole('gridcell').getAttribute('aria-rowindex')).toBe('1')
    expect(screen.getByRole('tooltip')).not.toBeNull()

    const directTooltip = screen.getByRole('tooltip')
    const directTooltipText = directTooltip.textContent
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.cellSize,
      clientY: geometry.gridTop + 1,
      pointerType: 'mouse',
    })
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.gridWidth + 1,
      clientY: geometry.gridTop,
      pointerType: 'mouse',
    })
    expect(screen.getByRole('tooltip')).toBe(directTooltip)
    expect(screen.getByRole('tooltip').textContent).toBe(directTooltipText)

    fireEvent.pointerLeave(grid, { pointerType: 'touch' })
    expect(screen.getByRole('tooltip')).not.toBeNull()

    fireEvent.pointerCancel(grid, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement).not.toBe(grid)

    // The horizontal gap after the first cell is not interactive.
    fireEvent.pointerDown(grid, {
      clientX: geometry.gridLeft + geometry.cellSize,
      clientY: geometry.gridTop + 1,
      pointerType: 'touch',
    })
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe('1')
    expect(screen.getByRole('gridcell').getAttribute('aria-rowindex')).toBe('1')

    // July 30 is after the supplied "today" (July 29), so its cell must not
    // replace the active virtual cell either.
    fireEvent.pointerDown(grid, {
      clientX: geometry.gridLeft + 12 * geometry.stride + 1,
      clientY: geometry.gridTop + 4 * geometry.stride + 1,
      pointerType: 'pen',
    })
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe('1')
    expect(screen.getByRole('gridcell').getAttribute('aria-rowindex')).toBe('1')

    fireEvent.pointerDown(grid, {
      clientX: geometry.gridLeft + geometry.stride + 1,
      clientY: geometry.gridTop + 1,
      pointerType: 'pen',
    })
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe('2')
    expect(screen.getByRole('gridcell').getAttribute('aria-rowindex')).toBe('1')
    const penTooltip = screen.getByRole('tooltip')
    const penTooltipText = penTooltip.textContent
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 2 * geometry.stride + 1,
      clientY: geometry.gridTop + 1,
      pointerType: 'pen',
      buttons: 1,
    })
    expect(screen.getByRole('tooltip')).toBe(penTooltip)
    expect(screen.getByRole('tooltip').textContent).toBe(penTooltipText)
    expect(screen.getByRole('gridcell').getAttribute('aria-colindex')).toBe('2')
    fireEvent.pointerCancel(grid, { pointerType: 'pen' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('uses borderless rounded gray cells without hatching untracked or partial days', async () => {
    const partialStart = new Date(2026, 6, 28, 12).getTime()
    render(
      <ActivityCalendar
        snapshot={activitySnapshot({
          coverage: {
            trackingStartedAt: partialStart,
            coverageGapAt: null,
          },
          days: [
            {
              dateKey: '2026-07-28',
              submitted: 2,
              downloadCompleted: 0,
              recoveredDownloadCompleted: 0,
            },
          ],
        })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')

    expect(canvasContext.roundRect).toHaveBeenCalled()
    expect(canvasContext.strokeRect).not.toHaveBeenCalled()
    expect(canvasContext.lineTo).not.toHaveBeenCalled()
    expect(canvasContext.stroke).not.toHaveBeenCalled()
    expect(canvasContext.roundRect.mock.calls[0]?.[4]).toBeGreaterThan(0)
  })

  it('keeps observed completion depth on the partial first day', async () => {
    const partialStart = new Date(2026, 6, 29, 12).getTime()
    render(
      <ActivityCalendar
        snapshot={activitySnapshot({
          coverage: {
            trackingStartedAt: partialStart,
            coverageGapAt: null,
          },
          days: [
            {
              dateKey: '2026-07-29',
              submitted: 4,
              downloadCompleted: 4,
              recoveredDownloadCompleted: 0,
            },
          ],
        })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 18)}
      />,
      { wrapper }
    )
    await flushFrames()

    expect(filledStyles).toContain('hsl(193 83% 50% / 0.68)')
    expect(screen.getByRole('grid').textContent).not.toContain('/')
  })

  it('draws a rich fixture across every completion depth', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot({
          coverage: {
            trackingStartedAt: new Date(2026, 6, 1).getTime(),
            coverageGapAt: null,
          },
          days: [
            {
              dateKey: '2026-07-25',
              submitted: 2,
              downloadCompleted: 0,
              recoveredDownloadCompleted: 0,
            },
            {
              dateKey: '2026-07-26',
              submitted: 1,
              downloadCompleted: 1,
              recoveredDownloadCompleted: 0,
            },
            {
              dateKey: '2026-07-27',
              submitted: 3,
              downloadCompleted: 2,
              recoveredDownloadCompleted: 0,
            },
            {
              dateKey: '2026-07-28',
              submitted: 5,
              downloadCompleted: 4,
              recoveredDownloadCompleted: 1,
            },
            {
              dateKey: '2026-07-29',
              submitted: 10,
              downloadCompleted: 8,
              recoveredDownloadCompleted: 2,
            },
          ],
        })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 18)}
      />,
      { wrapper }
    )
    await flushFrames()

    expect(filledStyles).toContain('#ebedf0')
    for (const opacity of [0.22, 0.42, 0.68, 0.95]) {
      expect(filledStyles).toContain(`hsl(193 83% 50% / ${opacity})`)
    }
    expect(canvasContext.stroke).not.toHaveBeenCalled()
  })

  it('renders only Monday, Wednesday, and Friday weekday labels', async () => {
    calendarSize.width = 390
    calendarSize.height = 100
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="detailed"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    expect(screen.getByText('Mon')).not.toBeNull()
    expect(screen.getByText('Wed')).not.toBeNull()
    expect(screen.getByText('Fri')).not.toBeNull()
    expect(screen.getByText('Mon').classList.contains('text-[10px]')).toBe(true)
    expect(screen.getByText('Mon').classList.contains('w-6')).toBe(true)
    expect(screen.queryByText('Sun')).toBeNull()
    expect(screen.queryByText('Tue')).toBeNull()
    expect(screen.queryByText('Thu')).toBeNull()
    expect(screen.queryByText('Sat')).toBeNull()
  })

  it('shows a compact unknown-data Tooltip without claiming zero observations', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    render(
      <ActivityCalendar
        snapshot={activitySnapshot({
          coverage: {
            trackingStartedAt: new Date(2026, 6, 29, 12).getTime(),
            coverageGapAt: null,
          },
          days: [],
        })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
    })

    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('No activity data')
    expect(tooltip.textContent).not.toContain('0 completed')
    expect(tooltip.textContent).not.toContain('0 submitted')
  })

  it('cancels pending dwell on exit, resize, disable, and unmount', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const pointer = {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
    }

    fireEvent.pointerMove(grid, pointer)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    fireEvent.pointerLeave(grid)
    expect(vi.getTimerCount()).toBe(0)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.pointerMove(grid, pointer)
    emitResize(grid, calendarSize.width + 1, calendarSize.height)
    await flushFrames()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.pointerMove(grid, pointer)
    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        interactive={false}
        now={new Date(2026, 6, 29, 12)}
      />
    )
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()

    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    fireEvent.pointerMove(grid, pointer)
    view.unmount()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('cleans a pending gap-close timer on disable and unmount', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const cell = {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
    }
    const gap = {
      clientX: geometry.gridLeft + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    }

    fireEvent.pointerMove(grid, cell)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    const baseUiTimerCount = vi.getTimerCount()
    fireEvent.pointerMove(grid, gap)
    expect(vi.getTimerCount()).toBeGreaterThan(baseUiTimerCount)

    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        interactive={false}
        now={new Date(2026, 6, 29, 12)}
      />
    )
    // Base UI may schedule one transition-completion timer while closing the
    // controlled popup; the calendar's separate gap-grace timer must be gone.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)

    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    fireEvent.pointerMove(grid, cell)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    const restoredBaseUiTimerCount = vi.getTimerCount()
    fireEvent.pointerMove(grid, gap)
    expect(vi.getTimerCount()).toBeGreaterThan(restoredBaseUiTimerCount)
    view.unmount()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(restoredBaseUiTimerCount)
  })

  it('keeps the keyboard Tooltip open when the pointer leaves', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    act(() => grid.focus())
    expect(document.activeElement).toBe(grid)
    const tooltip = await screen.findByRole('tooltip')
    const activeCell = screen.getByRole('gridcell')
    const activePosition = {
      column: activeCell.getAttribute('aria-colindex'),
      row: activeCell.getAttribute('aria-rowindex'),
    }
    fireEvent.pointerLeave(grid)
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement).toBe(grid)
    expect(screen.getByTestId('activity-focus-overlay')).not.toBeNull()
    expect(activeCell.getAttribute('aria-colindex')).toBe(activePosition.column)
    expect(activeCell.getAttribute('aria-rowindex')).toBe(activePosition.row)
    fireEvent.keyDown(grid, { key: 'ArrowLeft' })
    expect(screen.getByRole('tooltip')).not.toBeNull()
    act(() => grid.blur())
    expect(document.activeElement).not.toBe(grid)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(screen.queryByTestId('activity-focus-overlay')).toBeNull()
  })

  it('closes an already-portaled Tooltip when interaction is disabled', async () => {
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    fireEvent.focus(grid)
    expect(await screen.findByRole('tooltip')).not.toBeNull()

    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        interactive={false}
        now={new Date(2026, 6, 29, 12)}
      />
    )

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(grid.getAttribute('tabindex')).toBe('-1')
    expect(grid.hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('allows the one-row stale state to override the normal calendar minimum', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        className="min-h-[48px] flex-1"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    expect(screen.getByRole('grid').classList.contains('min-h-[48px]')).toBe(
      true
    )
    expect(screen.getByRole('grid').classList.contains('min-h-[56px]')).toBe(
      false
    )
  })

  it('coalesces resize work and reallocates for same-size DPR changes', async () => {
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    const canvas = screen.getByTestId('activity-canvas') as HTMLCanvasElement
    const initialDraws = canvasContext.clearRect.mock.calls.length
    expect(canvas.width).toBe(180)

    emitResize(grid, 190, 80)
    emitResize(grid, 200, 80)
    await flushFrames()
    expect(canvas.width).toBe(200)
    expect(canvasContext.clearRect).toHaveBeenCalledTimes(initialDraws + 1)

    changeDpr(2)
    await flushFrames()
    expect(canvas.width).toBe(400)
    expect(canvasContext.setTransform).toHaveBeenLastCalledWith(
      2,
      0,
      0,
      2,
      0,
      0
    )
    expect(
      mediaQueries.some((query) => query.query === '(resolution: 2dppx)')
    ).toBe(true)
  })

  it('updates CSS dimensions when a resize and DPR change keep the same bitmap size', () => {
    const canvas = document.createElement('canvas')
    const baseGeometry = selectActivityGeometry({
      width: 180,
      height: 80,
      contentLevel: 'compact',
    })
    if (!baseGeometry) throw new Error('Missing test geometry')

    drawActivityCanvas(
      canvas,
      [],
      { ...baseGeometry, width: 100, height: 80 },
      'light',
      2
    )
    expect(canvas.width).toBe(200)
    expect(canvas.height).toBe(160)
    expect(canvas.style.width).toBe('100px')
    expect(canvas.style.height).toBe('80px')

    drawActivityCanvas(
      canvas,
      [],
      { ...baseGeometry, width: 200, height: 160 },
      'light',
      1
    )
    expect(canvas.width).toBe(200)
    expect(canvas.height).toBe(160)
    expect(canvas.style.width).toBe('200px')
    expect(canvas.style.height).toBe('160px')
  })

  it('preserves the hovered date and cancels stale gap grace on resize', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="focus"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const grid = screen.getByRole('grid')
    const initialGeometry = selectActivityGeometry({
      width: 180,
      height: 80,
      contentLevel: 'focus',
    })
    if (!initialGeometry) throw new Error('Missing initial geometry')
    fireEvent.pointerMove(grid, {
      clientX: initialGeometry.gridLeft + 1,
      clientY: initialGeometry.gridTop + 1,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    const before = screen.getByRole('tooltip').textContent

    fireEvent.pointerMove(grid, {
      clientX: initialGeometry.gridLeft + initialGeometry.cellSize,
      clientY: initialGeometry.gridTop + 1,
    })
    emitResize(grid, 390, 100)
    await flushFrames()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS)

    const expandedGeometry = selectActivityGeometry({
      width: 390,
      height: 100,
      contentLevel: 'focus',
    })
    if (!expandedGeometry) throw new Error('Missing expanded geometry')
    const anchor = screen.getByTestId('activity-tooltip-anchor')
    expect(screen.getByRole('tooltip').textContent).toBe(before)
    expect(Number.parseFloat(anchor.style.left)).toBe(
      expandedGeometry.gridLeft + 13 * expandedGeometry.stride
    )
  })

  it('keeps gap grace running across a cells-only snapshot update', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + 1,
      clientY: geometry.gridTop + 1,
    })
    await advanceTimersByTime(ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    fireEvent.pointerMove(grid, {
      clientX: geometry.gridLeft + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    })

    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot({ revision: 2 })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    await flushFrames()
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS - 1)
    expect(screen.getByRole('tooltip')).not.toBeNull()
    await advanceTimersByTime(1)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('preserves pending dwell and warm traversal across data-only updates', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const view = render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing test geometry')
    const grid = screen.getByRole('grid')
    const point = (column: number) => ({
      clientX: geometry.gridLeft + column * geometry.stride + 1,
      clientY: geometry.gridTop + 1,
    })
    const gap = {
      clientX: geometry.gridLeft + geometry.cellSize,
      clientY: geometry.gridTop + 1,
    }

    fireEvent.pointerMove(grid, point(0))
    await advanceTimersByTime(250)
    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot({ revision: 2 })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    await flushFrames()
    await advanceTimersByTime(49)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(1)
    expect(screen.getByRole('tooltip')).not.toBeNull()

    fireEvent.pointerMove(grid, gap)
    await advanceTimersByTime(ACTIVITY_TOOLTIP_CLOSE_GRACE_MS)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advanceTimersByTime(250)
    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot({ revision: 3 })}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    await flushFrames()
    fireEvent.pointerMove(grid, point(1))
    expect(screen.getByRole('tooltip')).not.toBeNull()
  })

  it('uses the same light-mode depth scale for Canvas and the legend', async () => {
    calendarSize.width = 720
    calendarSize.height = 130
    render(
      <ActivityCalendar
        snapshot={activitySnapshot()}
        contentLevel="focus"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()

    const legend = screen.getByRole('img')
    expect(legend.classList.contains('text-[10px]')).toBe(true)
    const swatches = legend.querySelectorAll('span[aria-hidden="true"]')
    expect(swatches).toHaveLength(5)
    const geometry = selectActivityGeometry({
      width: calendarSize.width,
      height: calendarSize.height,
      contentLevel: 'focus',
    })
    if (!geometry) throw new Error('Missing legend geometry')
    for (const swatch of swatches) {
      expect((swatch as HTMLElement).style.width).toBe(`${geometry.cellSize}px`)
      expect((swatch as HTMLElement).style.height).toBe(
        `${geometry.cellSize}px`
      )
    }
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe(
      'var(--muted)'
    )
    for (const [index, opacity] of [0.22, 0.42, 0.68, 0.95].entries()) {
      expect(
        (swatches[index + 1] as HTMLElement).style.backgroundColor
      ).toContain(String(opacity))
    }
  })

  it('redraws from resolvedTheme without adding a root observer', async () => {
    const stableSnapshot = activitySnapshot()
    const view = render(
      <ActivityCalendar
        snapshot={stableSnapshot}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />,
      { wrapper }
    )
    await flushFrames()
    const initialDraws = canvasContext.clearRect.mock.calls.length

    themeHarness.resolvedTheme = 'dark'
    view.rerender(
      <ActivityCalendar
        snapshot={stableSnapshot}
        contentLevel="compact"
        now={new Date(2026, 6, 29, 12)}
      />
    )
    await flushFrames()

    expect(canvasContext.clearRect).toHaveBeenCalledTimes(initialDraws + 1)
    expect(resizeObservers).not.toHaveLength(0)
    expect(mutationObserverConstructionCount).toBe(0)
  })

  it('advances the default local day after a midnight snapshot render', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 6, 29, 23, 59))
    const view = render(
      <ActivityCalendar snapshot={activitySnapshot()} contentLevel="compact" />,
      { wrapper }
    )
    await flushFrames()
    expect(
      within(screen.getByRole('grid'))
        .getByRole('row')
        .getAttribute('aria-rowindex')
    ).toBe('4')

    vi.setSystemTime(new Date(2026, 6, 30, 0, 1))
    view.rerender(
      <ActivityCalendar
        snapshot={activitySnapshot({ revision: 2 })}
        contentLevel="compact"
      />
    )
    await flushFrames()

    expect(
      within(screen.getByRole('grid'))
        .getByRole('row')
        .getAttribute('aria-rowindex')
    ).toBe('5')
  })
})
