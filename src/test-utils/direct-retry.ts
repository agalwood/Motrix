import {
  type DownloadTask,
  TaskInstancePhase,
  TaskStatus,
} from '@shared/types/task'
import { makeDownloadTask } from './task'

export function makeRetainedHttpTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  const task = makeDownloadTask({
    id: 'native-http-task',
    engineTaskId: '0123456789abcdef',
    status: TaskStatus.Error,
    uris: ['https://example.test/file.bin'],
    diskPath: '/downloads/file.bin.motrix',
    finalPath: '/downloads/file.bin',
    saveDir: '/downloads',
    finalName: 'file.bin',
    totalBytes: 4194304,
    downloadedBytes: 524288,
    progress: 0.125,
    ...overrides,
  })
  return {
    ...task,
    instances: [
      {
        instanceId: `${task.id}:primary`,
        motrixId: task.id,
        gid: task.engineTaskId,
        phase: TaskInstancePhase.HttpDownload,
        status: task.status,
        progress: task.progress,
        totalBytes: task.totalBytes,
        downloadedBytes: task.downloadedBytes,
        uploadedBytes: 0,
        diskPath: task.diskPath,
        transitionPhase: task.transitionPhase,
        uris: task.uris,
        uriHash: null,
        payload: {
          directReplay: {
            version: 1,
            replayability: 'requires-credentials',
            requestModifiers: ['cookies'],
            engineContextVersion: 1,
          },
        },
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    ],
  }
}
