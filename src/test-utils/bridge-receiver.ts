import { EventEmitter } from 'node:events'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { BridgeReceiverDeps } from '@core/bridge-receiver/bridge-receiver'
import { TaskManager } from '@core/task/task-manager'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { vi } from 'vitest'

/** Typed receiver dependencies with inert IO; each call owns independent state. */
export function makeBridgeReceiverDeps(
  overrides: Partial<BridgeReceiverDeps> = {}
): BridgeReceiverDeps {
  let serial = 0
  return {
    getDefaultSaveDir: () => '/downloads',
    pickName: vi.fn(async (_dir, name) => name),
    createTask: vi.fn(async () => ({
      gid: `gid-${++serial}`,
      taskId: `task-${serial}`,
    })),
    removeTask: vi.fn(async () => {}),
    submitMagnetForFileSelection: vi.fn(async () => 'magnet-task'),
    isMagnetFileSelectionEnabled: () => false,
    eventBus: new EventEmitter(),
    bridgeBus: new BridgeEventBus(),
    localize: (code) => code,
    ffmpegBinaryPath: null,
    taskManager: new TaskManager(),
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    segmentAria2: {
      addUri: vi.fn(async () => 'segment'),
      forceRemove: vi.fn(async () => {}),
      removeDownloadResult: vi.fn(async () => {}),
      tellStatus: vi.fn(async () => null),
      onComplete: vi.fn(),
      onError: vi.fn(),
    },
    tmpRoot: '/tmp/motrix-test',
    persistTask: vi.fn(async () => {}),
    ...overrides,
  }
}

export function makeDirectSubmit(
  idempotencyKey?: string
): DownloadSubmitParams {
  return {
    source: {
      pageUrl: 'https://example.com/',
      pageTitle: 'Fixture',
      detectedAt: 1,
    },
    selection: {
      kind: 'direct',
      primary: {
        url: 'https://example.com/file.zip',
        headers: {},
        cookies: [],
        refererPolicy: 'strict-origin-when-cross-origin',
      },
    },
    meta: { suggestedFilename: 'file.zip', qualityLabel: 'source' },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
}

export function makeExtensionContext(): MdxpSessionContext {
  return {
    identity: { kind: 'extension', browser: 'chromium', extensionId: 'test' },
    startedAt: 0,
    isReady: () => true,
    markReady: () => {},
    isAuthorized: () => true,
    markAuthorized: () => {},
    pendingPair: null,
  }
}
