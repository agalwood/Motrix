import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Queries } from '@shared/protocol/queries'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => transportMock.invoke(...args),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const listeners =
        transportMock.listeners.get(channel) ??
        new Set<(...args: unknown[]) => void>()
      listeners.add(callback)
      transportMock.listeners.set(channel, listeners)
    },
    off: (channel: string, callback: (...args: unknown[]) => void) => {
      transportMock.listeners.get(channel)?.delete(callback)
    },
    onConnectionChange: () => () => {},
    platform: 'web',
  },
}))

import { ActivityTab } from './activity-tab'

describe('ActivityTab poison safety', () => {
  beforeEach(() => {
    transportMock.invoke.mockReset()
    transportMock.listeners.clear()
  })

  it('renders the safe unavailable state for a malformed Activity snapshot', async () => {
    transportMock.invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetTaskSpeedHistory) return Promise.resolve([])
      if (channel === Queries.GetTaskInspectorActivity) {
        return Promise.resolve({
          taskId: 'poison-task',
          revision: 1,
          timeline: null,
          lifetime: {
            points: [{ t: 1, down: Number.NaN, up: 0, flags: 0 }],
          },
        })
      }
      return Promise.reject(new Error(`unexpected query: ${channel}`))
    })

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 'poison-task',
          updatedAt: 1_721_390_398_000,
        })}
      />
    )

    expect(
      await screen.findByText('Lifetime activity is unavailable.')
    ).toBeVisible()
    expect(screen.getByTestId('task-inspector-activity-root')).toBeVisible()
  })
})
