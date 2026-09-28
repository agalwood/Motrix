// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStatus } from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { moveTasks } from './move-tasks'
import type { TaskActionDeps } from './shared'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'moveTasks with real aria2',
  () => {
    it('moves paused downloads in the scheduling queue in both directions', async () => {
      const baseDir = await mkdtemp(path.join(tmpdir(), 'motrix-queue-'))
      const handle = await spawnAria2ForTest({ baseDir })
      let disconnect: (() => void) | undefined
      try {
        const connection = await connectAdapter(handle)
        disconnect = connection.disconnect
        const { rpc, adapter } = connection
        const tasks = new Map()
        const gids: string[] = []
        for (const name of ['a', 'b', 'c', 'd']) {
          // Paused tasks never make a network request.
          const gid = await rpc.addUri([`http://127.0.0.1/queue-${name}`], {
            pause: 'true',
          })
          gids.push(gid)
          tasks.set(
            name,
            makeDownloadTask({
              id: name,
              engineTaskId: gid,
              status: TaskStatus.Paused,
            })
          )
        }
        const deps = {
          adapter,
          taskManager: { getById: (id: string) => tasks.get(id) },
          log: { warn: vi.fn() },
        } as unknown as TaskActionDeps
        expect(await adapter.listWaitingTaskIds()).toEqual(gids)
        expect(
          (await moveTasks({ taskIds: ['c', 'b'], direction: 'up' }, deps))
            .moved
        ).toEqual(['b', 'c'])
        expect(await adapter.listWaitingTaskIds()).toEqual([
          gids[1],
          gids[2],
          gids[0],
          gids[3],
        ])
        await moveTasks({ taskIds: ['b', 'c'], direction: 'down' }, deps)
        expect(await adapter.listWaitingTaskIds()).toEqual(gids)
        expect(
          (await moveTasks({ taskIds: ['a'], direction: 'up' }, deps)).unchanged
        ).toEqual(['a'])
        await moveTasks({ taskIds: ['d', 'b'], direction: 'top' }, deps)
        expect(await adapter.listWaitingTaskIds()).toEqual([
          gids[1],
          gids[3],
          gids[0],
          gids[2],
        ])
        await moveTasks({ taskIds: ['d', 'b'], direction: 'bottom' }, deps)
        expect(await adapter.listWaitingTaskIds()).toEqual([
          gids[0],
          gids[2],
          gids[1],
          gids[3],
        ])
      } finally {
        disconnect?.()
        await handle.kill()
        await rm(baseDir, { recursive: true, force: true })
      }
    }, 20_000)
  }
)
