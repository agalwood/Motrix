import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import enUS from '@shared/locales/en-US.json'
import zhCN from '@shared/locales/zh-CN.json'
import { TaskHistoryEventKind } from '@shared/types/task-inspector-activity'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActivityChartModel } from './activity-chart-model'
import { LifetimeTransferCard } from './lifetime-transfer-card'

const markerGroups = [
  {
    id: 'pause',
    events: [],
    kind: TaskHistoryEventKind.Paused,
    occurredAt: 1_500,
    rangeStartAt: 1_500,
    rangeEndAt: 1_500,
    count: 1,
  },
]

function chartModel(sampleCount = 2) {
  return buildActivityChartModel({
    range: 'lifetime',
    sessionPoints: [],
    lifetimePoints: Array.from({ length: sampleCount }, (_, index) => ({
      t: 1_000 + index * 1_000,
      down: 1_024 * (index + 1),
      up: 128 * (index + 1),
      flags: 0,
    })),
    markerGroups,
    selectedMarkerId: null,
  })
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  )
}

function logicalLeafPaths(value: unknown): string[] {
  return [
    ...new Set(
      leafPaths(value).map((path) =>
        path.replace(/_(?:zero|one|two|few|many|other)$/, '')
      )
    ),
  ].sort()
}

describe('LifetimeTransferCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('keeps the named query wrapper unpadded around its responsive card surface', () => {
    const { container } = render(
      <LifetimeTransferCard
        model={chartModel()}
        range="lifetime"
        sampleCount={2}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const card = screen.getByTestId('task-inspector-activity-transfer-card')
    const surface = screen.getByTestId(
      'task-inspector-activity-transfer-surface'
    )
    expect(card).toHaveClass('@container/transfer', 'min-w-0')
    expect(card).not.toHaveClass('border', 'p-3')
    expect(surface).toHaveClass('border', 'p-3')
    expect(surface.className).not.toContain('@[420px]/transfer:p-4')
    expect(surface.innerHTML).toContain('@[420px]/transfer:flex-row')
    expect(container.querySelectorAll('.recharts-area')).toHaveLength(0)
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(2)
    expect(
      container.querySelector('.activity-transfer-bar-down')
    ).toBeInTheDocument()
    expect(
      container.querySelector('.activity-transfer-bar-up')
    ).toBeInTheDocument()
    const downBars = container.querySelectorAll(
      '.activity-transfer-bar-down .recharts-rectangle'
    )
    const upBars = container.querySelectorAll(
      '.activity-transfer-bar-up .recharts-rectangle'
    )
    expect([...downBars, ...upBars]).not.toHaveLength(0)
    expect(
      [...downBars, ...upBars].every(
        (bar) =>
          bar.getAttribute('width') === '5' &&
          bar.getAttribute('d')?.includes('A ')
      )
    ).toBe(true)

    const firstDownBar = downBars[0]
    const firstUpBar = upBars[0]
    expect(
      Number(firstUpBar?.getAttribute('y')) +
        Number(firstUpBar?.getAttribute('height'))
    ).toBeCloseTo(Number(firstDownBar?.getAttribute('y')))
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('keeps dense samples spaced inside a full-bleed horizontal scroller', () => {
    render(
      <LifetimeTransferCard
        model={chartModel(60)}
        range="lifetime"
        sampleCount={60}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const frame = screen.getByTestId('activity-transfer-chart-frame')
    const scroller = screen.getByTestId('activity-transfer-chart-scroller')
    const canvas = screen.getByTestId('activity-transfer-chart-canvas')

    expect(frame).toHaveClass('-mx-3')
    expect(frame.className).not.toContain('@[420px]/transfer:-mx-4')
    expect(scroller).toHaveClass('overflow-x-auto', 'overflow-y-hidden')
    expect(canvas).toHaveClass('min-w-full')
    expect(canvas).toHaveStyle({ minWidth: '960px' })
  })

  it('keeps compact Y-axis speed labels on the right edge', () => {
    const { container } = render(
      <LifetimeTransferCard
        model={chartModel()}
        range="lifetime"
        sampleCount={2}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    expect(container.querySelector('.recharts-yAxis')).toHaveClass(
      'text-[10px]',
      'tabular-nums'
    )
    expect(
      container.querySelectorAll(
        '.recharts-yAxis-tick-lines > .recharts-cartesian-axis-tick'
      )
    ).toHaveLength(2)
    const scale = screen.getByTestId('activity-transfer-speed-scale')
    expect(scale).toHaveClass('absolute', 'right-3', 'tabular-nums')
    expect(scale.children).toHaveLength(2)
    expect(scale).not.toHaveTextContent('0 B/s')
    expect(
      [...scale.children].every((label) =>
        label.classList.contains('translate-y-1')
      )
    ).toBe(true)
    expect(
      container.querySelectorAll('.recharts-cartesian-grid-horizontal line')
    ).toHaveLength(2)
    const plotClip = container.querySelector('clipPath > rect')
    const plotTop = Number(plotClip?.getAttribute('y'))
    const plotHeight = Number(plotClip?.getAttribute('height'))
    const gridYCoordinates = [
      ...container.querySelectorAll('.recharts-cartesian-grid-horizontal line'),
    ]
      .map((line) => Number(line.getAttribute('y1')))
      .sort((left, right) => left - right)
    expect(gridYCoordinates).toEqual([plotTop, plotTop + plotHeight / 2])
    const downBars = [
      ...container.querySelectorAll(
        '.activity-transfer-bar-down .recharts-rectangle'
      ),
    ]
    const gridLine = container.querySelector(
      '.recharts-cartesian-grid-horizontal line'
    )
    const plotLeft = Number(gridLine?.getAttribute('x1'))
    const plotRight = Number(gridLine?.getAttribute('x2'))
    const firstBarX = Number(downBars[0]?.getAttribute('x'))
    const lastBarX = Number(downBars.at(-1)?.getAttribute('x'))

    expect(gridLine).not.toBeNull()
    expect(firstBarX).toBeGreaterThanOrEqual(plotLeft + 5)
    expect(lastBarX + 5).toBeLessThanOrEqual(plotRight - 5)
  })

  it('labels the actual stacked peak and its midpoint', () => {
    const peak = 13.6 * 1024 ** 2
    const model = buildActivityChartModel({
      range: 'session',
      sessionPoints: [
        { t: 1_000, down: peak, up: 0 },
        { t: 2_000, down: 0, up: 0 },
      ],
      lifetimePoints: [],
      markerGroups: [],
      selectedMarkerId: null,
    })
    render(
      <LifetimeTransferCard
        model={model}
        range="session"
        sampleCount={2}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const scale = screen.getByTestId('activity-transfer-speed-scale')
    expect(scale).toHaveTextContent('13.6 MB/s')
    expect(scale).toHaveTextContent('6.8 MB/s')
    expect(scale).not.toHaveTextContent('19.1 MB/s')
  })

  it('formats X-axis labels as HH:mm:ss without AM or PM', () => {
    const startAt = new Date(2026, 0, 1, 13, 4, 5).getTime()
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        { t: startAt, down: 1_024, up: 128, flags: 0 },
        { t: startAt + 60_000, down: 2_048, up: 256, flags: 0 },
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const { container } = render(
      <LifetimeTransferCard
        model={model}
        range="lifetime"
        sampleCount={2}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const xAxisText = container.textContent
    expect(xAxisText).toContain('13:04:05')
    expect(xAxisText).not.toMatch(/\b(?:AM|PM)\b/)
  })

  it('keeps a rounded baseline dot for samples without traffic', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        { t: 1_000, down: 0, up: 0, flags: 0 },
        { t: 2_000, down: 1_024, up: 128, flags: 0 },
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const { container } = render(
      <LifetimeTransferCard
        model={model}
        range="lifetime"
        sampleCount={2}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const baselineDot = container.querySelector(
      '.activity-transfer-bar-down .recharts-rectangle'
    )
    const plotClip = container.querySelector('clipPath > rect')
    const plotBottom =
      Number(plotClip?.getAttribute('y')) +
      Number(plotClip?.getAttribute('height'))
    expect(baselineDot).toHaveAttribute('height', '5')
    expect(baselineDot).toHaveAttribute('width', '5')
    expect(baselineDot?.getAttribute('d')).toContain('A 2.5,2.5')
    expect(
      container.querySelector('.activity-transfer-zero-line')
    ).not.toBeInTheDocument()
    expect(
      Number(baselineDot?.getAttribute('y')) +
        Number(baselineDot?.getAttribute('height'))
    ).toBeLessThanOrEqual(plotBottom)
  })

  it('keeps bars at 5px when close timestamps collapse the numeric-axis band', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        { t: 1_000, down: 1_024, up: 128, flags: 0 },
        { t: 4_600, down: 2_048, up: 256, flags: 0 },
        { t: 3_601_000, down: 4_096, up: 512, flags: 0 },
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const { container } = render(
      <LifetimeTransferCard
        model={model}
        range="lifetime"
        sampleCount={3}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )

    const bars = container.querySelectorAll(
      '.activity-transfer-bar .recharts-rectangle'
    )
    expect(bars).not.toHaveLength(0)
    expect([...bars].every((bar) => bar.getAttribute('width') === '5')).toBe(
      true
    )
  })

  it('uses a roving radiogroup with Arrow and Home/End selection', () => {
    const onRangeChange = vi.fn()
    const { rerender } = render(
      <LifetimeTransferCard
        model={chartModel()}
        range="lifetime"
        sampleCount={2}
        onRangeChange={onRangeChange}
        onSelectMarker={vi.fn()}
      />
    )

    const radios = screen.getAllByRole('radio')
    const session = radios[0] as HTMLButtonElement
    const lifetime = radios[1] as HTMLButtonElement
    expect(
      screen.getByRole('heading', { name: 'Lifetime transfer' })
    ).toBeInTheDocument()
    expect(session).toHaveAttribute('tabindex', '-1')
    expect(lifetime).toHaveAttribute('aria-checked', 'true')

    lifetime.focus()
    fireEvent.keyDown(lifetime, { key: 'ArrowLeft' })
    expect(onRangeChange).toHaveBeenCalledWith('session')
    expect(session).toHaveFocus()

    rerender(
      <LifetimeTransferCard
        model={chartModel()}
        range="session"
        sampleCount={2}
        onRangeChange={onRangeChange}
        onSelectMarker={vi.fn()}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Session transfer' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Lifetime transfer' })
    ).toBeNull()
    fireEvent.keyDown(session, { key: 'End' })
    expect(onRangeChange).toHaveBeenCalledWith('lifetime')
    expect(lifetime).toHaveFocus()
  })

  it.each([
    { count: 0, samples: '0 samples', seconds: '0 seconds' },
    { count: 1, samples: '1 sample', seconds: '1 second' },
    { count: 2, samples: '2 samples', seconds: '2 seconds' },
  ])(
    'pluralizes visible and accessible counts for $count observations',
    ({ count, samples, seconds }) => {
      render(
        <LifetimeTransferCard
          model={chartModel(count)}
          range="lifetime"
          sampleCount={count}
          lifetimeSummary={{
            points: [],
            averageDownloadSpeed: 0,
            peakDownloadSpeed: 0,
            peakUploadSpeed: 0,
            activeMs: count * 1_000,
            updatedAt: 1_000,
            accuracy: 'estimated',
          }}
          onRangeChange={vi.fn()}
          onSelectMarker={vi.fn()}
        />
      )

      expect(
        screen.getByText(`Adaptive resolution · ${samples}`)
      ).toBeInTheDocument()
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        expect.stringContaining(`${seconds}. ${samples}.`)
      )
    }
  )

  it('keeps the English and Chinese Activity logical keys equal', () => {
    expect(logicalLeafPaths(enUS.panel.downloads.inspector.activity)).toEqual(
      logicalLeafPaths(zhCN.panel.downloads.inspector.activity)
    )
  })
})
