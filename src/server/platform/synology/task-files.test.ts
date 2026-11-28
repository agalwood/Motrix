import { createHash } from 'node:crypto'
import {
  appendFile,
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
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServerDownloadPathPolicy } from '../../download-path-policy'
import { SynologyTaskFiles } from './task-files'

// 构造符合 aria2 DefaultBtProgressInfoFile v1 格式的控制文件，用于单测校验
function makeAria2ControlFile(
  options: {
    infoHashHex?: string
    pieceLength?: number
    totalLength?: bigint
    bitfieldLength?: number
  } = {}
): Buffer {
  const hashBytes = options.infoHashHex
    ? Buffer.from(options.infoHashHex, 'hex')
    : Buffer.alloc(0)
  const bitfieldLength = options.bitfieldLength ?? 4
  const buf = Buffer.alloc(10 + hashBytes.length + 24 + bitfieldLength)
  buf.writeUInt16BE(1, 0) // version = 1
  if (hashBytes.length > 0) buf.writeUInt32BE(1, 2) // extension: infoHashCheckEnabled
  buf.writeUInt32BE(hashBytes.length, 6)
  hashBytes.copy(buf, 10)
  const base = 10 + hashBytes.length
  buf.writeUInt32BE(options.pieceLength ?? 1024 * 1024, base)
  buf.writeBigUInt64BE(options.totalLength ?? 4096n, base + 4)
  buf.writeBigUInt64BE(0n, base + 12)
  buf.writeUInt32BE(bitfieldLength, base + 20)
  return buf
}

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

it('allows deleting active/paused HTTP .motrix partial and .aria2 sidecar even across trailing writes', async () => {
  const finalPath = path.join(root, 'archive.zip')
  const tempPath = `${finalPath}.motrix`
  const sidecarPath = `${tempPath}.aria2`
  const httpTask = makeDownloadTask({
    id: 'http-partial-1',
    type: TaskType.Http,
    saveDir: root,
    finalPath,
    diskPath: tempPath,
    status: TaskStatus.Downloading,
  })
  // 创建任务时磁盘上目标临时路径不存在，建立独占预留
  await guard.create(httpTask, () => {
    database.prepare('INSERT INTO tasks VALUES(?)').run(httpTask.id)
  })
  await writeFile(tempPath, 'chunk-1')
  await writeFile(sidecarPath, makeAria2ControlFile())

  // 删除预检应通过并锁定 .motrix 与 .aria2 的物理 inode
  await expect(guard.checkRemoval(httpTask, tempPath)).resolves.toBeUndefined()

  // 模拟 forceRemoveTask 停止前 aria2 追加写入（size/mtime 改变但 dev:ino 不变）
  await appendFile(tempPath, '-chunk-2')
  const tempInfo = await lstat(tempPath, { bigint: true })
  const sidecarInfo = await lstat(sidecarPath, { bigint: true })
  await expect(
    guard.removalIdentity(httpTask, tempPath, tempPath)
  ).resolves.toBe(`${tempInfo.dev}:${tempInfo.ino}`)
  await expect(
    guard.removalIdentity(httpTask, sidecarPath, sidecarPath)
  ).resolves.toBe(`${sidecarInfo.dev}:${sidecarInfo.ino}`)

  // 若文件被替换成不同 inode，仍必须严格拒绝
  await rename(tempPath, `${tempPath}.old`)
  await writeFile(tempPath, 'replaced')
  await expect(
    guard.removalIdentity(httpTask, tempPath, tempPath)
  ).rejects.toThrow('Task output changed')
})

it('allows deleting legacy HTTP partial tasks via live engine or valid aria2 sidecar, while rejecting forged sidecars', async () => {
  const finalPath = path.join(root, 'legacy.bin')
  const tempPath = `${finalPath}.motrix`
  const sidecarPath = `${tempPath}.aria2`
  const legacyTask = makeDownloadTask({
    id: 'http-legacy-1',
    type: TaskType.Http,
    saveDir: root,
    finalPath,
    diskPath: tempPath,
    status: TaskStatus.Paused,
    engineTaskId: '1111222233334444',
  })
  // 模拟升级前已存在且未写入 partial_claims 的旧任务（仅登记了 directory）
  database.prepare('INSERT INTO tasks VALUES(?)').run(legacyTask.id)
  const dirInfo = await lstat(root, { bigint: true })
  database
    .prepare(
      "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?)"
    )
    .run(legacyTask.id, root, `${dirInfo.dev}:${dirInfo.ino}`)

  await writeFile(tempPath, 'partial-bytes')
  // 伪造非法 .aria2 文件头时，必须拒绝删除
  await writeFile(sidecarPath, 'not-an-aria2-control-file')
  await expect(guard.checkRemoval(legacyTask, tempPath)).rejects.toThrow(
    'Task output changed'
  )

  // 写入合法 aria2 v1 控制文件后允许删除
  await writeFile(sidecarPath, makeAria2ControlFile())
  await expect(
    guard.checkRemoval(legacyTask, tempPath)
  ).resolves.toBeUndefined()

  // 验证通过实时引擎归属（无 .aria2 文件也可通过）
  const liveFinal = path.join(root, 'live.bin')
  const liveTemp = `${liveFinal}.motrix`
  const liveTask = makeDownloadTask({
    id: 'http-live-engine-1',
    type: TaskType.Http,
    saveDir: root,
    finalPath: liveFinal,
    diskPath: liveTemp,
    status: TaskStatus.Downloading,
    engineTaskId: 'aaaa1111bbbb2222',
  })
  database.prepare('INSERT INTO tasks VALUES(?)').run(liveTask.id)
  database
    .prepare(
      "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?)"
    )
    .run(liveTask.id, root, `${dirInfo.dev}:${dirInfo.ino}`)
  await writeFile(liveTemp, 'active-data')
  guard.setRuntimeDeps({
    getEngineTask: async (gid) =>
      gid === liveTask.engineTaskId ? { dir: root, files: [liveTemp] } : null,
  })
  await expect(guard.checkRemoval(liveTask, liveTemp)).resolves.toBeUndefined()
})

it('rejects pre-existing files at create time and validates BT sidecar infoHash strictly', async () => {
  const preExisting = path.join(root, 'existing.bin.motrix')
  await writeFile(preExisting, 'someone-else-file')
  const hijackedTask = makeDownloadTask({
    id: 'http-preexisting-1',
    type: TaskType.Http,
    saveDir: root,
    finalPath: path.join(root, 'existing.bin'),
    diskPath: preExisting,
    status: TaskStatus.Paused,
  })
  // 创建时文件已存在，绝不可写入独占预留
  await guard.create(hijackedTask, () => {
    database.prepare('INSERT INTO tasks VALUES(?)').run(hijackedTask.id)
  })
  await expect(guard.checkRemoval(hijackedTask, preExisting)).rejects.toThrow(
    'Task output changed'
  )

  // 单文件 BT：仅当 .aria2 中的 20 字节 infoHash 精确匹配时才允许删除
  const btPath = path.join(root, 'distro.iso')
  const btSidecar = `${btPath}.aria2`
  const infoHash = '0123456789abcdef0123456789abcdef01234567'
  const wrongHash = 'fedcba9876543210fedcba9876543210fedcba98'
  const btTask = makeDownloadTask({
    id: 'bt-single-1',
    type: TaskType.Bt,
    saveDir: root,
    finalPath: btPath,
    diskPath: btPath,
    infoHash,
    status: TaskStatus.Paused,
  })
  database.prepare('INSERT INTO tasks VALUES(?)').run(btTask.id)
  const dirInfo = await lstat(root, { bigint: true })
  database
    .prepare(
      "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?)"
    )
    .run(btTask.id, root, `${dirInfo.dev}:${dirInfo.ino}`)
  await writeFile(btPath, 'iso-part')
  await writeFile(btSidecar, makeAria2ControlFile({ infoHashHex: wrongHash }))
  await expect(guard.checkRemoval(btTask, btPath)).rejects.toThrow(
    'Task output changed'
  )

  await writeFile(btSidecar, makeAria2ControlFile({ infoHashHex: infoHash }))
  await expect(guard.checkRemoval(btTask, btPath)).resolves.toBeUndefined()
})

it('validates unfinished multi-file BT directories against torrent member whitelist and rejects unrelated files', async () => {
  // 构造最小合法多文件 .torrent（包含 files: [sub/part1.bin, part2.bin]）
  const infoDict = Buffer.concat([
    Buffer.from(
      'd5:filesld6:lengthi100e4:pathl3:sub9:part1.bineed6:lengthi50e4:pathl9:part2.bineee4:name8:pkg-root12:piece lengthi16384e6:pieces20:'
    ),
    Buffer.alloc(20, 0xaa),
    Buffer.from('e'),
  ])
  const torrentBytes = Buffer.concat([
    Buffer.from('d4:info'),
    infoDict,
    Buffer.from('e'),
  ])
  const infoHash = createHash('sha1').update(infoDict).digest('hex')
  const btDir = path.join(root, 'pkg-root')
  const multiBt = makeDownloadTask({
    id: 'bt-multi-partial-1',
    type: TaskType.Bt,
    saveDir: root,
    finalPath: btDir,
    diskPath: btDir,
    infoHash,
    torrentMetaPath: '/mock/meta.torrent',
    status: TaskStatus.Paused,
  })
  guard.setRuntimeDeps({
    readTorrentMeta: async () => new Uint8Array(torrentBytes),
  })
  await guard.create(multiBt, () => {
    database.prepare('INSERT INTO tasks VALUES(?)').run(multiBt.id)
  })
  await mkdir(path.join(btDir, 'sub'), { recursive: true })
  await writeFile(path.join(btDir, 'sub', 'part1.bin'), 'half-downloaded')
  await writeFile(
    path.join(btDir, 'sub', 'part1.bin.aria2'),
    makeAria2ControlFile({ infoHashHex: infoHash })
  )
  await expect(guard.checkRemoval(multiBt, btDir)).resolves.toBeUndefined()

  // 一旦目录中混入不属于种子的第三方文件，必须拒绝删除
  await writeFile(path.join(btDir, 'stranger.txt'), 'do-not-delete')
  await expect(guard.checkRemoval(multiBt, btDir)).rejects.toThrow(/Untracked/)
})
