import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { TaskInspectorActivityState } from '@renderer/hooks/use-task-inspector-activity'
import { makeTaskInspectorActivitySnapshot } from '@test-utils/task-inspector-activity'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeedingDuration } from './seeding-duration'

let activity: TaskInspectorActivityState = { status: 'loading', snapshot: null }
vi.mock('@renderer/hooks/use-task-inspector-activity', () => ({
  useTaskInspectorActivity: () => activity,
}))
afterEach(cleanup)

describe('SeedingDuration', () => {
  it('distinguishes missing historical data from a recorded zero', () => {
    const snapshot = makeTaskInspectorActivitySnapshot()
    activity = { status: 'ready', snapshot }
    const { rerender } = render(<SeedingDuration taskId="task-1" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    snapshot.summary.seeding = { activeMs: 0, trackingStartedAt: 1000 }
    rerender(<SeedingDuration taskId="task-1" />)
    expect(screen.getByText('00:00')).toBeInTheDocument()
    snapshot.summary.seeding.activeMs = 3_661_000
    rerender(<SeedingDuration taskId="task-1" />)
    expect(screen.getByText('1:01:01')).toBeInTheDocument()
  })
})
