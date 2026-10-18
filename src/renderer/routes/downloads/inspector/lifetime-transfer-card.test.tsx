import '@testing-library/jest-dom/vitest'
import { DirectionProvider } from '@renderer/components/ui/direction'
import { i18n } from '@renderer/lib/i18n'
import enUS from '@shared/locales/en-US.json'
import zhCN from '@shared/locales/zh-CN.json'
import { TaskTransferSampleFlag } from '@shared/types/task-inspector-activity'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ActivityChartModel,
  type ActivityChartRange,
  buildActivityChartModel,
} from './activity-chart-model'
import { LifetimeTransferCard } from './lifetime-transfer-card'

function model(end = 400000, flags = 0) {
  return buildActivityChartModel({
    range: 'lifetime',
    sessionPoints: [],
    lifetimePoints: [
      { t: 100000, down: 1024, up: 256, flags: 0 },
      { t: 200000, down: 4096, up: 512, flags },
      { t: end, down: 2048, up: 256, flags: 0 },
    ],
    markerGroups: [],
    selectedMarkerId: null,
  })
}
function card(
  data: ActivityChartModel = model(),
  range: ActivityChartRange = 'session'
) {
  return (
    <LifetimeTransferCard
      model={data}
      range={range}
      sampleCount={data.observationCount}
      onRangeChange={vi.fn()}
      onSelectMarker={vi.fn()}
    />
  )
}
function windowRange() {
  const view = screen.getByTestId('activity-transfer-chart-viewport')
  return [Number(view.dataset.start), Number(view.dataset.end)]
}

describe('LifetimeTransferCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const width =
          this.id === 'recharts_measurement_span'
            ? (this.textContent?.length ?? 0) * 6
            : this.dataset.slot === 'slider-thumb'
              ? 16
              : 520
        return {
          width,
          height: 16,
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: width,
          bottom: 16,
          toJSON: () => ({}),
        }
      }
    )
  })
  afterEach(() => vi.restoreAllMocks())
  it('uses independent smooth paths and the Dashboard colors with 12% fills', () => {
    const { container } = render(card())
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(0)
    expect(container.querySelectorAll('.recharts-area')).toHaveLength(2)
    const download = container.querySelector(
      '.activity-transfer-line-down .recharts-area-curve'
    )
    const upload = container.querySelector(
      '.activity-transfer-line-up .recharts-area-curve'
    )
    expect(download).toHaveAttribute('stroke', 'var(--color-down)')
    expect(upload).toHaveAttribute('stroke', 'var(--color-up)')
    expect(upload).toHaveAttribute('stroke-dasharray', '5 3')
    expect(download?.getAttribute('d')).toContain('C')
    for (const area of container.querySelectorAll('.recharts-area-area'))
      expect(area).toHaveAttribute('fill-opacity', '0.12')
    expect(container.querySelector('style')?.textContent).toContain(
      '--color-down: hsl(var(--chart-1))'
    )
    expect(container.querySelector('style')?.textContent).toContain(
      '--color-up: hsl(var(--chart-2))'
    )
    expect(
      screen.getByTestId('activity-transfer-speed-scale')
    ).toHaveTextContent('4.1 KB/s')
  })
  it.each(['ltr', 'rtl'] as const)(
    'keeps a 60-second window that follows and pauses when browsing in %s',
    (direction) => {
      const { rerender } = render(
        <DirectionProvider direction={direction}>{card()}</DirectionProvider>
      )
      expect(windowRange()).toEqual([340000, 400000])
      rerender(
        <DirectionProvider direction={direction}>
          {card(model(410000))}
        </DirectionProvider>
      )
      expect(windowRange()).toEqual([350000, 410000])
      fireEvent.click(screen.getByRole('button', { name: 'Earlier history' }))
      expect(windowRange()).toEqual([320000, 380000])
      rerender(
        <DirectionProvider direction={direction}>
          {card(model(420000))}
        </DirectionProvider>
      )
      expect(windowRange()).toEqual([320000, 380000])
      fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }))
      expect(windowRange()).toEqual([360000, 420000])
    }
  )
  it('supports horizontal wheel history browsing and keeps vertical page scrolling alone', () => {
    render(card())
    const view = screen.getByTestId('activity-transfer-chart-viewport')
    Object.defineProperty(view, 'clientWidth', { value: 600 })
    fireEvent.wheel(view, { deltaX: -100, deltaY: 0 })
    expect(windowRange()).toEqual([330000, 390000])
    fireEvent.wheel(view, { deltaX: 0, deltaY: 100 })
    expect(windowRange()).toEqual([330000, 390000])
    fireEvent.wheel(view, { deltaX: 100, deltaY: 0 })
    expect(view).toHaveAttribute('data-following', 'true')
  })
  it('supports keyboard history navigation and returning to the latest samples', () => {
    render(card())
    const view = screen.getByTestId('activity-transfer-chart-viewport')
    fireEvent.keyDown(view, { key: 'ArrowLeft' })
    expect(windowRange()).toEqual([325000, 385000])
    fireEvent.keyDown(view, { key: 'Home' })
    expect(windowRange()).toEqual([100000, 160000])
    fireEvent.keyDown(view, { key: 'End' })
    expect(windowRange()).toEqual([340000, 400000])
  })
  it('provides a full overview with accessible range selection and zoom controls', async () => {
    const user = userEvent.setup()
    render(card(model(), 'lifetime'))
    expect(windowRange()).toEqual([100000, 400000])
    expect(screen.getByTestId('activity-chart-overview')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(windowRange()).toEqual([250000, 400000])
    const end = screen.getByRole('slider', { name: 'Range end' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    expect(windowRange()).toEqual([250000, 399000])
    const start = screen.getByRole('slider', { name: 'Range start' })
    expect(start).toHaveAttribute(
      'aria-valuetext',
      expect.stringMatching(/\d{2}:\d{2}:\d{2}/)
    )
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(windowRange()).toEqual([100000, 400000])
  })
  it('shows missing intervals as broken paths rather than false zero-speed samples', () => {
    const { container } = render(
      card(model(400000, TaskTransferSampleFlag.CoverageGap), 'lifetime')
    )
    expect(screen.getByText('No samples')).toBeVisible()
    expect(container.querySelector('.activity-chart-gap')).toBeInTheDocument()
    const lines = container.querySelectorAll(
      '.activity-transfer-line-down .recharts-area-curve'
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(
      model(400000, TaskTransferSampleFlag.CoverageGap).points.some(
        (point) => point.down === null
      )
    ).toBe(true)
  })
  it('preserves range radio keyboard controls and reset behavior', () => {
    const onRangeChange = vi.fn()
    render(
      <LifetimeTransferCard
        model={model()}
        range="session"
        sampleCount={3}
        onRangeChange={onRangeChange}
        onSelectMarker={vi.fn()}
      />
    )
    const recent = screen.getByRole('radio', { name: 'Last 60s' })
    expect(recent).toHaveAttribute('aria-checked', 'true')
    recent.focus()
    fireEvent.keyDown(recent, { key: 'End' })
    expect(onRangeChange).toHaveBeenCalledWith('lifetime')
  })
  it('keeps empty and true-zero charts readable', () => {
    const data = buildActivityChartModel({
      range: 'session',
      sessionPoints: [],
      lifetimePoints: [{ t: 1000, down: 0, up: 0, flags: 0 }],
      markerGroups: [],
      selectedMarkerId: null,
    })
    render(card(data))
    expect(screen.getByText('No network traffic right now.')).toBeVisible()
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /Latest download 0 B\/s, upload 0 B\/s/
    )
  })

  it('includes dates when full history crosses days and keeps second precision in range labels', async () => {
    const first = new Date(2026, 0, 1, 10, 0, 0).getTime()
    const last = new Date(2026, 0, 3, 10, 0, 0).getTime()
    const data = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        { t: first, down: 1024, up: 0, flags: 0 },
        { t: last, down: 2048, up: 0, flags: 0 },
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const { container } = render(card(data, 'lifetime'))
    const labels = [
      ...container.querySelectorAll('.recharts-cartesian-axis-tick-value'),
    ].map((node) => node.textContent)
    expect(labels.some((label) => label?.includes('1/1'))).toBe(true)
    expect(labels.some((label) => label?.includes('1/3'))).toBe(true)
    expect(
      screen.getByTestId('activity-transfer-chart-viewport')
    ).toHaveAttribute('aria-valuetext', expect.stringContaining('2026'))
    expect(
      await screen.findByRole('slider', { name: 'Range start' })
    ).toHaveAttribute('aria-valuetext', expect.stringContaining('10:00:00'))
  })

  it('uses distinct clock labels when zoomed to a one-second lifetime interval', () => {
    const data = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        { t: 1000, down: 1024, up: 0, flags: 0 },
        { t: 2000, down: 0, up: 0, flags: 0 },
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const { container } = render(card(data, 'lifetime'))
    const labels = [
      ...container.querySelectorAll('.recharts-cartesian-axis-tick-value'),
    ].map((node) => node.textContent)
    expect(labels).toHaveLength(2)
    expect(new Set(labels).size).toBe(2)
  })
  it('keeps the summary inside the unpadded card wrapper and uses valid locale keys', () => {
    render(
      <LifetimeTransferCard
        model={model()}
        range="session"
        sampleCount={3}
        summary={<div>summary</div>}
        onRangeChange={vi.fn()}
        onSelectMarker={vi.fn()}
      />
    )
    const wrapper = screen.getByTestId('task-inspector-activity-transfer-card')
    expect(wrapper).not.toHaveClass('p-3')
    expect(
      within(
        screen.getByTestId('task-inspector-activity-transfer-surface')
      ).getByText('summary')
    ).toBeVisible()
    const logicalKeys = (value: Record<string, string>) =>
      [
        ...new Set(
          Object.keys(value).map((key) => key.replace(/_(one|other)$/, ''))
        ),
      ].sort()
    expect(logicalKeys(enUS.panel.downloads.inspector.activity.chart)).toEqual(
      logicalKeys(zhCN.panel.downloads.inspector.activity.chart)
    )
  })
})
