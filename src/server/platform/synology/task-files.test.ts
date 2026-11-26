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

it('keeps directory identity stable across file mutations and legacy birthtime stamps', async () => {
  // 模拟在目录内持续创建和删除 .motrix / .aria2 文件导致目录 ctime 变更
  const tempFile = path.join(root, 'active.bin.motrix')
  const controlFile = `${tempFile}.aria2`
  await writeFile(tempFile, 'downloading')
  await writeFile(controlFile, 'control')
  await expect(guard.checkDirectory(task)).resolves.toBeUndefined()

  const dirInfo = await lstat(root, { bigint: true })
  const stored = database
    .prepare(
      "SELECT identity FROM synology_task_paths WHERE task_id=? AND role='directory' AND path=?"
    )
    .get(task.id, root) as { identity: string }
  // 新写入的目录身份仅包含 dev:ino，不包含会退化为 ctime 的 birthtimeNs
  expect(stored.identity).toBe(`${dirInfo.dev}:${dirInfo.ino}`)

  // 兼容旧版 DSM 数据库中已写入的 `${dev}:${ino}:${staleBirthtimeNs}` 三段格式
  database
    .prepare(
      "UPDATE synology_task_paths SET identity=? WHERE task_id=? AND role='directory' AND path=?"
    )
    .run(`${dirInfo.dev}:${dirInfo.ino}:123456789`, task.id, root)
  await expect(guard.checkDirectory(task)).resolves.toBeUndefined()

  // 物理目录被替换（inode 变化）时仍必须拒绝
  const parked = `${root}-legacy-parked`
  await rename(root, parked)
  try {
    await mkdir(root)
    await expect(guard.checkDirectory(task)).rejects.toThrow(
      'Task download directory changed'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rename(parked, root)
  }

  // 兼容旧版五段文件戳与三段目录树戳
  await writeFile(task.finalPath, 'legacy-content')
  const fileInfo = await lstat(task.finalPath, { bigint: true })
  database
    .prepare(
      `INSERT INTO synology_task_paths VALUES (?,'output',?,?,?,NULL,NULL)
       ON CONFLICT(task_id,role,path) DO UPDATE SET identity=excluded.identity,stamp=excluded.stamp`
    )
    .run(
      task.id,
      task.finalPath,
      `${fileInfo.dev}:${fileInfo.ino}`,
      `${fileInfo.dev}:${fileInfo.ino}:987654321:${fileInfo.size}:${fileInfo.mtimeNs}`
    )
  await expect(guard.outputIdentity(task, task.finalPath)).resolves.toBe(
    `${fileInfo.dev}:${fileInfo.ino}`
  )
  await writeFile(task.finalPath, 'tampered-content')
  await expect(guard.outputIdentity(task, task.finalPath)).rejects.toThrow(
    'Task output changed'
  )
})
