import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { TaskStatus } from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { expect, it, vi } from 'vitest'
import { PollingScheduler } from './polling-scheduler'
import { translateRawToTask } from './translate'
import type { Aria2TaskStatus } from './types'

it.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'keeps 7,458-file tasks out of list RPC payloads and reconciles selection edits (real aria2)',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-task-streams-'))
    const handle = await spawnAria2ForTest({ baseDir: root })
    const wired = await connectAdapter(handle)
    const getFiles = vi.spyOn(wired.rpc, 'getFiles')
    const multicall = vi.spyOn(wired.rpc, 'multicall')
    let latest: Aria2TaskStatus | undefined
    let updates = 0
    const scheduler = new PollingScheduler(
      wired.rpc,
      new EventBus(),
      () => {},
      (tasks) => {
        if (tasks[0]) latest = tasks[0]
        updates += 1
      }
    )
    try {
      const count = 7458
      const names = Array.from(
        { length: count },
        (_, index) => `file-${index}.bin`
      )
      const files = names
        .map((name) => `d6:lengthi1e4:pathl${name.length}:${name}ee`)
        .join('')
      const torrent = Buffer.concat([
        Buffer.from(
          `d4:infod5:filesl${files}e4:name6:bundle12:piece lengthi16384e6:pieces20:`
        ),
        Buffer.alloc(20, 1),
        Buffer.from('7:privatei1eee'),
      ])
      const gid = await wired.adapter.addTorrent({
        metadata: torrent,
        saveDir: root,
        pause: true,
      })
      scheduler.start()
      await vi.waitFor(() => expect(latest?.gid).toBe(gid))
      expect(translateRawToTask(latest!).fileCount).toBe(count)
      expect(translateRawToTask(latest!).bt?.selectedFiles).toHaveLength(count)
      expect(translateRawToTask(latest!).status).toBe(TaskStatus.Paused)
      const before = updates
      await scheduler.handleNotification('aria2.onDownloadPause', { gid })
      await vi.waitFor(() => expect(updates).toBeGreaterThan(before + 1))
      expect(getFiles).toHaveBeenCalledTimes(1)
      const results = (await multicall.mock.results.at(-1)!.value) as unknown[]
      // The wire results themselves, before cache hydration, stay small.
      expect(Buffer.byteLength(JSON.stringify(results))).toBeLessThan(10_000)
      expect(JSON.stringify(results)).not.toContain('file-7457.bin')

      await wired.rpc.changeOption(gid, { 'select-file': '2-3' })
      await vi.waitFor(() =>
        expect(translateRawToTask(latest!).bt?.selectedFiles).toEqual([1, 2])
      )
      expect(getFiles).toHaveBeenCalledTimes(2)
      const details = await wired.adapter.getTaskFiles(gid)
      expect(details).toHaveLength(count)
      expect(
        details.filter((file) => file.selected).map((file) => file.index)
      ).toEqual([1, 2])
      expect(details.at(-1)?.path).toContain('file-7457.bin')
    } finally {
      await scheduler.stopAndDrain()
      wired.disconnect()
      await handle.kill()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)
