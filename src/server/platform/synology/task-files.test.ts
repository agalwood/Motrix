import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readArtifactIdentity } from '@core/plugin/finalize/artifact-identity'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServerDownloadPathPolicy } from '../../download-path-policy'
import { SynologyTaskFiles } from './task-files'

let database: Database.Database
let root: string
let guard: SynologyTaskFiles
let task: ReturnType<typeof makeDownloadTask>
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-dsm-claims-'))
  )
  database = new Database(':memory:')
  database.exec(`CREATE TABLE tasks(motrix_id TEXT PRIMARY KEY);
    CREATE TABLE plugin_finalize_journals(plan_id TEXT, task_id TEXT, phase TEXT,
    plan_json TEXT,target_identity_json TEXT)`)
  guard = new SynologyTaskFiles(
    { database, getAllTasks: () => [] },
    await createServerDownloadPathPolicy({
      defaultSaveDir: root,
      allowedSaveDirs: [root],
      initialize: false,
    })
  )
  await guard.initialize()
  const target = path.join(root, 'output')
  task = makeDownloadTask({
    saveDir: root,
    finalPath: target,
    diskPath: target,
    status: TaskStatus.Completed,
  })
  await guard.create(task, () => {
    database.prepare('INSERT INTO tasks VALUES(?)').run(task.id)
  })
})
afterEach(async () => {
  database.close()
  await rm(root, { recursive: true, force: true })
})

it('requires the historical publisher, matching bytes and the physical save directory', async () => {
  await writeFile(task.finalPath, 'original')
  await expect(guard.outputIdentity(task, task.finalPath)).rejects.toThrow(
    /No verified identity/
  )
  const original = await readArtifactIdentity(task.finalPath)
  database
    .prepare('INSERT INTO plugin_finalize_journals VALUES(?,?,?,?,?)')
    .run(
      'old-plan',
      task.id,
      'cleaned',
      JSON.stringify({ plan: { targetPath: task.finalPath } }),
      JSON.stringify(original)
    )
  await expect(guard.outputIdentity(task, task.finalPath)).resolves.toBe(
    original.platformFileId
  )
  const other = { ...task, id: 'other' }
  await guard.create(other, () => {
    database.prepare('INSERT INTO tasks VALUES(?)').run(other.id)
  })
  await expect(guard.checkRemoval(other, task.finalPath)).rejects.toThrow(
    /No verified identity/
  )
  await writeFile(task.finalPath, 'modified')
  await expect(guard.checkRemoval(task, task.finalPath)).rejects.toThrow(
    /changed/
  )
  await writeFile(task.finalPath, 'original')
  const parked = `${root}-parked`
  await rename(root, parked)
  try {
    await mkdir(root)
    await expect(guard.checkDirectory(task)).rejects.toThrow(/changed/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rename(parked, root)
  }
  await expect(
    guard.checkRemoval(task, task.finalPath)
  ).resolves.toBeUndefined()
})

it('refuses unrelated files during recursive deletion and changes during torrent verification', async () => {
  await mkdir(task.finalPath)
  const member = path.join(task.finalPath, 'member')
  await writeFile(member, 'content')
  const before = await guard.prepareStorageBinding(task, 'locate', [member])
  await rename(member, `${member}.parked`)
  await writeFile(member, 'another')
  await expect(before.bindVerified()).rejects.toThrow(/changed/)
  await rm(member)
  await rename(`${member}.parked`, member)
  await (
    await guard.prepareStorageBinding(task, 'locate', [member])
  ).bindVerified()
  await expect(
    guard.checkRemoval(task, task.finalPath)
  ).resolves.toBeUndefined()
  const unknown = path.join(task.finalPath, 'unrelated')
  await writeFile(unknown, 'preserve')
  await expect(guard.checkRemoval(task, task.finalPath)).rejects.toThrow(
    /Untracked/
  )
  await expect(guard.checkRemoval(task, unknown)).rejects.toThrow(/changed/)
  expect((await lstat(unknown)).isFile()).toBe(true)
})

it('rejects an unproven partial file without adopting it during deletion', async () => {
  task.status = TaskStatus.Paused
  await writeFile(task.diskPath, 'not owned')
  await expect(guard.checkRemoval(task, task.diskPath)).rejects.toThrow(
    /changed/
  )
  await rm(task.diskPath)
  await expect(guard.checkRemoval(task, task.diskPath)).resolves.toBeUndefined()
})
