import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import {
  TaskCompletedParamsSchema,
  TaskErrorParamsSchema,
  TaskProgressParamsSchema,
} from '@motrix/mdxp'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { ProgressPublisher } from './progress-publisher'

function fakeTask(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    engineTaskId: 'gid1',
    name: 'x.mp4',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    downloadSpeed: 100,
    etaSeconds: 5,
    saveDir: '/tmp',
    fileCount: 1,
    connections: 1,
    filename: 'x.mp4',
    sizeWhenDone: 1000,
    diskPath: '/tmp/x.mp4.motrix',
    finalPath: '/tmp/x.mp4',
    finalName: 'x.mp4',
    source: 'bridge',
    sourceMeta: {
      kind: 'direct',
      extensionId: 'e',
      browser: 'chromium',
      sessionKey: 'chromium:e',
      pageUrl: 'http://x',
      pageTitle: 't',
      qualityLabel: 'q',
      durationSec: null,
      submittedAt: 0,
    },
    ...over,
  })
}

function makeBusSpies() {
  const bus = {
    emitTaskProgress: vi.fn(),
    emitTaskCompleted: vi.fn(),
    emitTaskError: vi.fn(),
  } as unknown as BridgeEventBus
  return bus
}

describe('ProgressPublisher', () => {
  it('emits TaskProgress for bridge tasks only', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask())
    expect(
      (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1)
  })

  it('ignores user-source tasks', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask({ source: 'user', sourceMeta: null }))
    expect(
      (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(0)
  })

  it('maps TaskStatus.Paused to downloading phase (MDXP has no paused)', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask({ status: TaskStatus.Paused }))
    const event = (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: { phase: string } }
    expect(event.params.phase).toBe('downloading')
  })

  it('maps TaskStatus.FetchingMetadata to queued phase', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask({ status: TaskStatus.FetchingMetadata }))
    const event = (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: { phase: string } }
    expect(event.params.phase).toBe('queued')
  })

  it('emits event with sessionKey from sourceMeta', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask())
    const event = (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: unknown }
    expect(event.sessionKey).toBe('chromium:e')
  })

  it('TaskProgress params validate against MDXP schema', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskUpdated(fakeTask())
    const event = (bus.emitTaskProgress as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: unknown }
    const result = TaskProgressParamsSchema.safeParse(event.params)
    expect(result.success).toBe(true)
  })

  it('emits TaskCompleted on Completed status with filePath', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskCompleted(fakeTask({ status: TaskStatus.Completed }))
    expect(
      (bus.emitTaskCompleted as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1)
  })

  it('TaskCompleted event has correct sessionKey and filePath in params', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskCompleted(fakeTask({ status: TaskStatus.Completed }))
    const event = (bus.emitTaskCompleted as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: { filePath: string } }
    expect(event.sessionKey).toBe('chromium:e')
    expect(event.params.filePath).toBe('/tmp/x.mp4')
  })

  it('TaskCompleted params validate against MDXP schema', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus)
    pub.onTaskCompleted(fakeTask({ status: TaskStatus.Completed }))
    const event = (bus.emitTaskCompleted as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: unknown }
    const result = TaskCompletedParamsSchema.safeParse(event.params)
    expect(result.success).toBe(true)
  })

  it('emits TaskError on failure with error code', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus, () => 'Disk full')
    pub.onTaskFailed(
      fakeTask({ status: TaskStatus.Error, errorMessage: 'oom' }),
      'disk-full'
    )
    const event = (bus.emitTaskError as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      sessionKey: string
      params: { code: string; message: string }
    }
    expect(event.params.code).toBe('disk-full')
    expect(event.params.message).toBe('Disk full')
  })

  it('TaskError params validate against MDXP schema', () => {
    const bus = makeBusSpies()
    const pub = new ProgressPublisher(bus, () => 'Disk full')
    pub.onTaskFailed(
      fakeTask({ status: TaskStatus.Error, errorMessage: 'oom' }),
      'disk-full'
    )
    const event = (bus.emitTaskError as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sessionKey: string; params: unknown }
    const result = TaskErrorParamsSchema.safeParse(event.params)
    expect(result.success).toBe(true)
  })
})
