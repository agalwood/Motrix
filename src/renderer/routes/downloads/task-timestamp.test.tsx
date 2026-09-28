import '@testing-library/jest-dom/vitest'
import { __resetMinuteClockForTests } from '@renderer/hooks/use-minute-clock'
import { i18n } from '@renderer/lib/i18n'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTimestamp } from './task-timestamp'

describe('TaskTimestamp', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 15, 23, 59, 30))
    __resetMinuteClockForTests()
  })
  afterEach(async () => {
    cleanup()
    __resetMinuteClockForTests()
    vi.useRealTimers()
    await i18n.changeLanguage('en-US')
  })

  it('updates today at local midnight without changing the task or adding tab stops', () => {
    const timestamp = new Date(2026, 8, 15, 14, 32, 8).getTime()
    const { container } = render(<TaskTimestamp timestamp={timestamp} />)
    expect(screen.getByText('今天 14:32:08')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(30_000))
    const time = screen.getByText('昨天 14:32:08')
    expect(time).toHaveAttribute('datetime', new Date(timestamp).toISOString())
    expect(time).toHaveAttribute('tabindex', '-1')
    expect(time).toHaveAccessibleName(/2026年9月15日.*14:32:08/)
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps a full date in the inspector and reacts to language changes', async () => {
    render(
      <TaskTimestamp
        timestamp={new Date(2026, 8, 15, 14, 32, 8).getTime()}
        variant="inspector"
      />
    )
    expect(screen.getByText('2026年9月15日 14:32:08')).toBeInTheDocument()
    await act(() => i18n.changeLanguage('en-US'))
    expect(screen.getByText(/Sep 15, 2026, 2:32:08 PM/)).toBeInTheDocument()
  })

  it('distinguishes unrecorded history from a task that has not completed', () => {
    const { rerender } = render(<TaskTimestamp timestamp={null} />)
    expect(screen.getByText('—')).toHaveAccessibleName('未记录')
    rerender(<TaskTimestamp timestamp={null} pending />)
    expect(screen.getByText('—')).toHaveAccessibleName('尚未完成')
  })
})
