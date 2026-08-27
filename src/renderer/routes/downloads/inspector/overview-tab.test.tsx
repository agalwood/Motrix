import '@testing-library/jest-dom/vitest'

import { vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn().mockResolvedValue({ ok: true }) },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn().mockResolvedValue(undefined),
}))

import '@renderer/lib/i18n'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { DownloadErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { OverviewTab } from './overview-tab'

function renderOverviewTab(task: DownloadTask) {
  return render(
    <TooltipProvider>
      <OverviewTab task={task} />
    </TooltipProvider>
  )
}

const task: DownloadTask = {
  id: 't',
  engineTaskId: 'g',
  name: 'x',
  kind: TaskKind.Bt,
  instances: [],
  type: TaskType.Bt,
  status: TaskStatus.Downloading,
  progress: 0.78,
  totalBytes: 1_200_000_000,
  downloadedBytes: 936_000_000,
  downloadSpeed: 12_400_000,
  uploadSpeed: 1_200_000,
  etaSeconds: 32,
  saveDir: '/d',
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
  errorMessage: null,
  uris: [''],
  uploadedBytes: 0,
  uploadedBytesBaseline: 0,
  fileCount: 42,
  connections: 0,
  pieceLength: 1_048_576,
  infoHash: 'abc',
  errorCode: null,
  errorDetailKey: null,
  errorDetailParams: null,
  diagnosisRevision: 0,
  metadataProgress: 1,
  priority: 0,
  category: null,
  dlLimit: 0,
  ulLimit: 0,
  filename: 'x',
  sizeWhenDone: 1_200_000_000,
  diskPath: '/d/x.motrix/',
  finalPath: '/d/x/',
  finalName: 'x',
  transitionPhase: TransitionPhase.Idle,
  torrentMetaPath: null,
  source: 'user',
  sourceMeta: null,
  bt: {
    peers: 18,
    seeds: 3,
    ratio: 0.24,
    trackers: [],
    selectedFiles: [],
    peersInSwarm: 41,
    seedsInSwarm: 8,
    announceList: [],
    comment: null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
  },
}

function magnetMetadataInstance(taskId: string): DownloadTask['instances'][0] {
  return {
    instanceId: `meta:${taskId}`,
    motrixId: taskId,
    gid: 'metadata-gid',
    phase: TaskInstancePhase.MagnetMetadataResolution,
    status: TaskStatus.Error,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/tmp/metadata',
    transitionPhase: TransitionPhase.Idle,
    uris: ['magnet:?xt=urn:btih:timeout'],
    uriHash: null,
    payload: {},
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('OverviewTab', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    })
  })

  it('renders all four cards with content', () => {
    renderOverviewTab(task)
    expect(screen.getByText(/transfer/i)).toBeInTheDocument()
    expect(screen.getByText(/network/i)).toBeInTheDocument()
    expect(screen.getByText('0.24')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByText('18/41')).not.toBeInTheDocument()
    expect(screen.queryByText('3/8')).not.toBeInTheDocument()
  })

  it('copies the raw info hash', async () => {
    renderOverviewTab(task)
    await userEvent.click(screen.getByRole('button'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('abc')
  })

  describe('Error status', () => {
    it('renders the reason and hint for a DiskFull error', () => {
      renderOverviewTab({
        ...task,
        status: TaskStatus.Error,
        errorCode: DownloadErrorCode.DiskFull,
      })
      expect(screen.getByText('Disk is full')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Free up disk space or change the save folder, then retry'
        )
      ).toBeInTheDocument()
    })

    it('hides the hint for a ServerError (no hint key in the catalog)', () => {
      const { container } = renderOverviewTab({
        ...task,
        status: TaskStatus.Error,
        errorCode: DownloadErrorCode.ServerError,
      })
      expect(screen.getByText('Server returned an error')).toBeInTheDocument()
      expect(
        container.querySelector('[data-slot="alert-description"]')
      ).not.toBeInTheDocument()
    })

    it('shows the raw error message as inline technical detail', () => {
      renderOverviewTab({
        ...task,
        status: TaskStatus.Error,
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'ECONNREFUSED 127.0.0.1:9999',
      })
      const technicalDetail = screen.getByText('ECONNREFUSED 127.0.0.1:9999')
      const alertDescription = technicalDetail.closest(
        '[data-slot="alert-description"]'
      )

      expect(technicalDetail).toBeInTheDocument()
      expect(alertDescription).toHaveClass('min-w-0')
      expect(alertDescription).toContainElement(
        screen.getByText('Check your network connection, then retry')
      )
      expect(alertDescription?.parentElement).toContainElement(
        screen.getByText('Network connection failed')
      )
    })

    it('hides retry for a Mux-kind error task (not rebuildable)', () => {
      renderOverviewTab({
        ...task,
        status: TaskStatus.Error,
        kind: TaskKind.Mux,
        type: TaskType.Http,
        uris: ['https://example.com/x'],
        errorCode: DownloadErrorCode.NetworkError,
      })
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })

    it('hides retry for an HTTP error task even with uris (replay inputs are not persisted)', () => {
      renderOverviewTab({
        ...task,
        id: 'http-error',
        status: TaskStatus.Error,
        kind: TaskKind.Direct,
        type: TaskType.Http,
        uris: ['https://example.com/x'],
        errorCode: DownloadErrorCode.NetworkError,
      })
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })

    it('shows retry for a BT error task with its sidecar and dispatches RetryTasks', () => {
      renderOverviewTab({
        ...task,
        id: 'bt-error',
        status: TaskStatus.Error,
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        torrentMetaPath: '/sidecar/x.torrent',
        errorCode: DownloadErrorCode.NetworkError,
      })
      const retryButton = screen.getByRole('button', { name: 'Retry' })
      fireEvent.click(retryButton)
      expect(transport.invoke).toHaveBeenCalledWith(Commands.RetryTasks, [
        'bt-error',
      ])
    })

    it('adds Retry to the timeout Alert for unresolved magnet metadata', () => {
      renderOverviewTab({
        ...task,
        id: 'magnet-timeout',
        status: TaskStatus.Error,
        kind: TaskKind.Bt,
        type: TaskType.Magnet,
        torrentMetaPath: null,
        errorCode: DownloadErrorCode.Timeout,
        instances: [magnetMetadataInstance('magnet-timeout')],
      })

      expect(screen.getByText('Download timed out')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Check your connection speed and stability, then retry'
        )
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(transport.invoke).toHaveBeenCalledWith(Commands.RetryTasks, [
        'magnet-timeout',
      ])
    })
  })
})
