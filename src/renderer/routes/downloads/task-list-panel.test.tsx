import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import type { DownloadTask } from '@shared/types/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TaskListPanel } from './task-list-panel'

describe('TaskListPanel', () => {
  it('renders EmptyTasks when filtered task list is empty', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    render(
      <TaskListPanel
        tasks={[]}
        hasAnyTasks={false}
        selection={selection}
        filter="all"
        search=""
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument()
  })
})
