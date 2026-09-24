import { makeMediaProgress } from '@test-utils/media-progress'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { DownloadTask } from '@shared/types/task'
import { TaskKind, TaskStatus } from '@shared/types/task'
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
    expect(screen.getByText(/8\.00 GB/)).toBeInTheDocument()
  })
})

it('averages download fractions while counting post-processing separately', () => {
  const { rerender } = render(
    <MultiSelectionSummary
      tasks={[
        fake({
          kind: TaskKind.Hls,
          progress: 1,
          mediaProgress: makeMediaProgress({
            phase: 'muxing',
            download: {
              progress: 1,
              completedParts: 1000,
              totalParts: 1000,
              totalBytes: null,
            },
            muxProgress: 0.1,
          }),
        }),
        fake({ progress: 0.5 }),
      ]}
    />
  )
  expect(screen.getByText('75%')).toBeInTheDocument()
  expect(screen.getByText('Processing').parentElement).toHaveTextContent('1')
  expect(screen.getByText('Total size').parentElement).toHaveTextContent('—')
  rerender(
    <MultiSelectionSummary
      tasks={[
        fake({ kind: TaskKind.Hls, progress: 1 }),
        fake({ progress: 0.5 }),
      ]}
    />
  )
  expect(
    screen.getByText('Average download progress').parentElement
  ).toHaveTextContent('—')
})

it('does not let completed selections erase a known remaining download ETA', () => {
  render(
    <MultiSelectionSummary
      tasks={[
        fake({ status: TaskStatus.Completed }),
        fake({
          kind: TaskKind.Hls,
          mediaProgress: makeMediaProgress({
            download: {
              progress: 0.5,
              completedParts: 1,
              totalParts: 2,
              totalBytes: 1000,
            },
          }),
        }),
      ]}
    />
  )
  expect(screen.getByText('Longest ETA').parentElement).toHaveTextContent(
    '00:10'
  )
})
