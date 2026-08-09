import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MultiSelectionSummary } from './multi-selection-summary'

// Kept overrides: id:'a' (≠ 'task-1'), engineTaskId:'g' (≠ 'gid-1'),
// name:'n' (≠ 'task'), progress:0.5 (≠ 0), totalBytes:1_000_000 (≠ 0),
// downloadedBytes:500_000 (≠ 0), downloadSpeed:1000 (≠ 0),
// uploadSpeed:100 (≠ 0), etaSeconds:10 (≠ 0), saveDir:'/' (≠ ''),
// uris:[''] (≠ []), fileCount:1 (≠ 0), filename:'n' (≠ ''),
// sizeWhenDone:1_000_000 (≠ 0), diskPath:'/n' (≠ ''),
// finalPath:'/n' (≠ ''), finalName:'n' (≠ '').
// Dropped: kind:Direct (= default), type:Http (= default),
// status:Downloading (= default), all-zero/null/empty fields.
function fake(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 'a',
    engineTaskId: 'g',
    name: 'n',
    progress: 0.5,
    totalBytes: 1_000_000,
    downloadedBytes: 500_000,
    downloadSpeed: 1000,
    uploadSpeed: 100,
    etaSeconds: 10,
    saveDir: '/',
    uris: [''],
    fileCount: 1,
    filename: 'n',
    sizeWhenDone: 1_000_000,
    diskPath: '/n',
    finalPath: '/n',
    finalName: 'n',
    ...over,
  })
}

describe('MultiSelectionSummary', () => {
  it('computes aggregate totals and status distribution', () => {
    render(
      <MultiSelectionSummary
        tasks={[
          fake({
            id: 'a',
            status: TaskStatus.Downloading,
            sizeWhenDone: 4_000_000_000,
          }),
          fake({
            id: 'b',
            status: TaskStatus.Seeding,
            sizeWhenDone: 2_000_000_000,
          }),
          fake({
            id: 'c',
            status: TaskStatus.Downloading,
            sizeWhenDone: 2_000_000_000,
          }),
        ]}
      />
    )
    expect(screen.getByText(/totals/i)).toBeInTheDocument()
    // formatBytes(8_000_000_000) = "7.5 GB" (1024-base, value.toFixed(1))
    // Math: 8e9 / 1024^3 = 7.4506, toFixed(1) = "7.5"
    expect(screen.getByText(/7\.5 GB/)).toBeInTheDocument()
  })
})
