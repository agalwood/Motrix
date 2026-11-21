import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { DownloadHandoffJournal } from '@core/session/download-handoff-journal'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { TaskInstancePhase, TaskKind } from '@shared/types/task'
import { makeInstanceRow, makeTaskRow } from '@test-utils/task-rows'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateDesktopHandoff } from './desktop-download-handoff'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function fixture() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'handoff-output-'))
  )
  directories.push(dir)
  const taskId = 'handoff-task'
  const gid = '1234567890abcdef'
  const finalPath = path.join(dir, 'payload.bin')
  const diskPath = `${finalPath}.motrix`
  const request = {
    gid,
    uris: ['https://example.test/payload.bin'],
    saveDir: dir,
    filename: 'payload.bin',
    deferFilePublication: true,
  }
  const row = {
    task: { ...makeTaskRow(taskId, TaskKind.Direct), finalPath },
    instances: [
      {
        ...makeInstanceRow(
          'instance',
          taskId,
          gid,
          TaskInstancePhase.HttpDownload
        ),
        diskPath,
        uris: request.uris,
      },
    ],
  }
  const createDownload = vi.fn(async () => gid)
  const journal = {
    activate: vi.fn(
      async (
        _taskId: string,
        callbacks: Parameters<DownloadHandoffJournal['activate']>[1]
      ) => {
        const intent = {
          taskId,
          engineId: gid,
          saveDir: dir,
          canonicalPayload: '{}',
          engineRequest: request,
        }
        await callbacks.beforeStart?.(intent)
        await callbacks.start(intent)
        return 'activated' as const
      }
    ),
  } as unknown as DownloadHandoffJournal
  const activate = () =>
    activateDesktopHandoff(
      journal,
      { getTask: () => row } as unknown as MotrixDatabase,
      { createDownload } as unknown as EngineAdapter,
      taskId,
      async () => dir
    )
  return { activate, createDownload, request, finalPath, diskPath, row }
}

describe('desktop handoff with engine-owned publication', () => {
  it('validates the final filename while retaining the reserved temporary path', async () => {
    const f = await fixture()
    await expect(f.activate()).resolves.toBe('activated')
    expect(f.createDownload).toHaveBeenCalledExactlyOnceWith(f.request)
  })

  it('rejects a request that targets a different final file', async () => {
    const f = await fixture()
    f.request.filename = 'unowned.bin'
    await expect(f.activate()).rejects.toThrow(
      'Invalid desktop handoff activation'
    )
    expect(f.createDownload).not.toHaveBeenCalled()
  })

  it('rejects a reservation bound to a different temporary file', async () => {
    const f = await fixture()
    f.row.instances[0].diskPath = `${f.finalPath}.different`
    await expect(f.activate()).rejects.toThrow(
      'Invalid desktop handoff activation'
    )
    expect(f.createDownload).not.toHaveBeenCalled()
  })

  it.each(['finalPath', 'diskPath'] as const)(
    'preserves a pre-existing file at %s',
    async (field) => {
      const f = await fixture()
      await writeFile(f[field], 'existing payload')
      await expect(f.activate()).rejects.toThrow(
        'Handoff output is already occupied'
      )
      expect(f.createDownload).not.toHaveBeenCalled()
      expect(await readFile(f[field], 'utf8')).toBe('existing payload')
    }
  )
})
