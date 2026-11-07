import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { TaskInstancePhase } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, expect, it } from 'vitest'
import { NasFiles } from './files'
import { NasRecoveryAccess } from './recovery-access'
import { NasTaskAccess } from './task-access'

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/motrix-nas-recovery-'))
  cleanup.push(root)
  const downloads = path.join(root, 'downloads'),
    outside = path.join(root, 'outside')
  await mkdir(downloads)
  await mkdir(outside)
  const file = path.join(downloads, 'partial.bin')
  await writeFile(file, 'partial')
  let roots = [downloads]
  const files = new NasFiles({
    platform: 'synology',
    authorizedRoots: async () => roots,
    checkAccess: async () => true,
  })
  const policy = await files.policy(downloads)
  const task = makeDownloadTask({
    saveDir: downloads,
    finalPath: file,
    diskPath: file,
  })
  const actual = { directory: downloads, files: [file] }
  const recovery = new NasRecoveryAccess({
    access: new NasTaskAccess(files, policy),
    policy,
    tempDir: root,
    getTask: (gid) => (gid === 'owned' ? task : undefined),
    getEnginePaths: async () => actual,
  })
  return {
    root,
    downloads,
    outside,
    file,
    task,
    actual,
    recovery,
    revoke: () => {
      roots = []
    },
  }
}

it('holds unowned rows, revoked grants, and actual engine paths outside the task grant', async () => {
  const f = await fixture()
  expect(await f.recovery.authorizeResume('owned')).toBe(true)
  expect(await f.recovery.authorizeResume('unknown')).toBe(false)
  f.actual.files = [path.join(f.outside, 'injected.bin')]
  expect(await f.recovery.authorizeResume('owned')).toBe(false)
  f.actual.files = [f.file]
  f.revoke()
  expect(await f.recovery.authorizeResume('owned')).toBe(false)
  await expect(f.recovery.authorizeWrite(f.task)).rejects.toThrow()
})

it('rejects an output replaced by a symlink before restoring the engine', async () => {
  const f = await fixture()
  await writeFile(path.join(f.outside, 'private.bin'), 'private')
  await rm(f.file)
  await symlink(path.join(f.outside, 'private.bin'), f.file)
  expect(await f.recovery.authorizeResume('owned')).toBe(false)
})

it('allows protected metadata staging but rejects shared or symlinked metadata workspaces', async () => {
  const f = await fixture()
  const metadata = path.join(f.root, 'motrix-magnet-metadata-test')
  await mkdir(metadata, { mode: 0o700 })
  f.task.instances = [
    {
      phase: TaskInstancePhase.MagnetMetadataResolution,
      payload: { metadataDir: metadata },
    } as never,
  ]
  f.actual.directory = metadata
  f.actual.files = [path.join(metadata, 'metadata.torrent')]
  expect(await f.recovery.authorizeResume('owned')).toBe(true)
  f.task.instances[0].payload.metadataDir = f.downloads
  expect(await f.recovery.authorizeResume('owned')).toBe(false)
  f.task.instances[0].payload.metadataDir = metadata
  await rm(metadata, { recursive: true })
  await symlink(f.outside, metadata)
  expect(await f.recovery.authorizeResume('owned')).toBe(false)
})
