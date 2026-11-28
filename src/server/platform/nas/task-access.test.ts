import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type TaskInstance,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, expect, it, vi } from 'vitest'
import { createServerDownloadPathPolicy } from '../../download-path-policy'
import { NasTaskAccess } from './task-access'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
function instance(
  phase: TaskInstancePhase,
  payload: Record<string, unknown> = {}
): TaskInstance {
  return {
    instanceId: phase,
    motrixId: 'task-1',
    gid: null,
    phase,
    status: TaskStatus.Paused,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload,
    createdAt: 0,
    updatedAt: 0,
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/motrix-nas-task-'))
  roots.push(root)
  const shared = path.join(root, 'shared')
  await mkdir(shared)
  const privateDir = path.join(root, 'private')
  await mkdir(privateDir)
  const policy = await createServerDownloadPathPolicy({
    defaultSaveDir: shared,
    allowedSaveDirs: [shared],
    initialize: false,
  })
  const files = {
    authorizeFile: vi.fn(async (candidate: string) => {
      await policy.authorizeDirectory(path.dirname(candidate))
      return candidate
    }),
    check: vi.fn(async () => {}),
    authorizeRemoval: vi.fn(async () => {}),
  }
  const access = new NasTaskAccess(files, policy)
  return { root, shared, privateDir, files, access }
}

it('checks an existing partial output even when the final name does not exist yet', async () => {
  const f = await fixture()
  const finalPath = path.join(f.shared, 'file.bin')
  const diskPath = `${finalPath}.motrix`
  await writeFile(diskPath, 'partial')
  f.files.check.mockRejectedValue(new Error('read-only file'))
  await expect(
    f.access.authorizeWrite(
      makeDownloadTask({ saveDir: f.shared, finalPath, diskPath })
    )
  ).rejects.toThrow('read-only file')
  expect(f.files.check).toHaveBeenCalledWith(diskPath, 'writable')
})

it('rejects a missing output outside granted roots before the engine can create it', async () => {
  const f = await fixture()
  await expect(
    f.access.authorizeWrite(
      makeDownloadTask({
        saveDir: f.shared,
        finalPath: path.join(f.privateDir, 'new.bin'),
        diskPath: '',
      })
    )
  ).rejects.toThrow('outside')
})

it.each([TaskKind.Bt, TaskKind.Mux, TaskKind.Hls])(
  'does not require sharing application-private staging for %s tasks',
  async (kind) => {
    const f = await fixture()
    const staging = path.join(f.privateDir, 'staging')
    await mkdir(staging)
    const task = makeDownloadTask({
      kind,
      status: TaskStatus.Error,
      saveDir: f.shared,
      finalPath: '',
      diskPath: staging,
    })
    if (kind === TaskKind.Bt)
      task.instances = [instance(TaskInstancePhase.MagnetMetadataResolution)]
    await f.access.authorizeWrite(task)
    expect(f.files.authorizeFile).not.toHaveBeenCalledWith(
      staging,
      expect.anything()
    )
    await f.access.authorizeRemoval(task)
    expect(f.files.authorizeRemoval).not.toHaveBeenCalled()
  }
)

it('checks failed BT output reservations and deletes only user-facing targets', async () => {
  const f = await fixture()
  const output = path.join(f.shared, 'reserved')
  await mkdir(output)
  const task = makeDownloadTask({
    kind: TaskKind.Bt,
    saveDir: f.shared,
    finalPath: '',
    diskPath: f.privateDir,
  })
  task.instances = [
    instance(TaskInstancePhase.MagnetMetadataResolution, {
      btOutputReservation: {
        finalPath: output,
        infoHash: 'a'.repeat(40),
        multiFile: true,
      },
    }),
  ]
  await f.access.authorizeWrite(task)
  expect(f.files.check).toHaveBeenCalledWith(output, 'writable')
  await f.access.authorizeRemoval(task)
  expect(f.files.authorizeRemoval).toHaveBeenCalledExactlyOnceWith(
    output,
    expect.anything()
  )
})

it('checks payload storage after magnet metadata transitions to a BT download', async () => {
  const f = await fixture()
  const diskPath = path.join(f.shared, 'payload.motrix')
  await writeFile(diskPath, 'partial')
  const task = makeDownloadTask({
    kind: TaskKind.Bt,
    saveDir: f.shared,
    diskPath,
    instances: [
      instance(TaskInstancePhase.MagnetMetadataResolution),
      instance(TaskInstancePhase.BtDownload),
    ],
  })
  f.files.check.mockRejectedValue(new Error('file denied'))
  await expect(f.access.authorizeWrite(task)).rejects.toThrow('file denied')
  await f.access.authorizeRemoval(task)
  expect(f.files.authorizeRemoval).toHaveBeenCalledWith(
    diskPath,
    expect.anything()
  )
})

it('does not treat the selected folder as a file to delete while resolving metadata', async () => {
  const f = await fixture()
  const task = makeDownloadTask({
    kind: TaskKind.Bt,
    saveDir: f.shared,
    finalPath: f.shared,
    instances: [instance(TaskInstancePhase.MagnetMetadataResolution)],
  })
  await f.access.authorizeRemoval(task)
  expect(f.files.authorizeRemoval).not.toHaveBeenCalled()
})
