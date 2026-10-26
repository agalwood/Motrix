// @vitest-environment node
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { legacyBtRequestSourceSchema } from '@shared/schemas/legacy-bt-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyImportService } from './import-service'
import { LegacyBtRequestSourceService } from './legacy-bt-request-source'
import { digestBytes } from './session-parser'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const infoHash = '1111111111111111111111111111111111111111'
const uri = `magnet:?xt=urn:btih:${infoHash}&dn=example`

async function fixture(kind: 'magnet' | 'bt' = 'magnet', gid = true) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'legacy-bt-request-'))
  )
  const profile = path.join(root, 'profile')
  const backupRoot = path.join(root, 'backups')
  const downloads = path.join(root, 'downloads')
  await mkdir(profile)
  await mkdir(downloads)
  let metadata: Buffer | undefined
  if (kind === 'bt') {
    const source = path.resolve(
      'tests/fixtures/legacy-v1/generated/downloads/a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent'
    )
    await cp(source, path.join(profile, 'test.torrent'))
    metadata = await readFile(source)
  }
  await writeFile(path.join(profile, 'user.json'), '{"theme":"auto"}')
  await writeFile(
    path.join(profile, 'system.json'),
    JSON.stringify({
      dir: downloads,
      'all-proxy': 'http://private-user:private-pass@proxy.example:8080',
      'https-proxy': 'secure.example:8081',
      'proxy-method': 'tunnel',
    })
  )
  await writeFile(
    path.join(profile, 'download.session'),
    `${kind === 'magnet' ? uri : 'test.torrent'}\n${gid ? ' gid=0123456789abcdef\n' : ''} select-file=1\n`
  )
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  const importer = new LegacyImportService({
    db,
    taskManager: new TaskManager(),
    backupRoot,
    isProcessRunning: () => false,
    publishTasks: vi.fn(),
  })
  cleanups.push(async () => {
    await importer.drain()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const source = await importer.addSource(profile)
  const preview = await importer.scan(source.sourceHandle)
  expect(preview.items).toHaveLength(1)
  expect(preview.items[0].selectable).toBe(true)
  const run = await importer.commit({
    previewId: preview.previewId,
    itemIds: [preview.items[0].itemId],
  })
  await expect.poll(() => importer.getRun(run.runId).stage).toBe('completed')
  const taskId = db.getAllTasks()[0].task.motrixId
  const service = new LegacyBtRequestSourceService({ db, backupRoot })
  return {
    root,
    profile,
    backupRoot,
    backup: path.join(backupRoot, run.runId),
    db,
    taskId,
    metadata,
    service,
  }
}

describe('durable private legacy BT request sources', () => {
  it.each([true, false])(
    'restores a magnet route after deleting the original task and v1 directory (gid=%s)',
    async (gid) => {
      const f = await fixture('magnet', gid)
      const ref = await f.service.capture(f.taskId, { uri, infoHash })
      expect(legacyBtRequestSourceSchema.parse(ref)).toEqual(ref)
      expect(JSON.stringify(ref)).not.toContain('private')
      expect(JSON.stringify(f.db.getAllTasks())).not.toContain('private-user')
      expect(JSON.stringify(f.db.getAllTasks())).not.toContain('private-pass')
      f.db.deleteTask(f.taskId)
      await rm(f.profile, { recursive: true })
      expect(await f.service.resolve(ref, infoHash)).toMatchObject({
        allProxy: 'http://private-user:private-pass@proxy.example:8080/',
        httpsProxy: 'http://secure.example:8081/',
        proxyMethod: 'tunnel',
      })
    }
  )

  it.each([true, false])(
    'binds BT metadata to its source and replays independently (gid=%s)',
    async (gid) => {
      const f = await fixture('bt', gid)
      const ref = await f.service.capture(f.taskId, { metadata: f.metadata })
      expect(ref.torrentDigest).toBe(digestBytes(f.metadata!))
      f.db.deleteTask(f.taskId)
      await rm(f.profile, { recursive: true })
      expect(await f.service.resolve(ref)).toMatchObject({
        proxyMethod: 'tunnel',
      })
    }
  )

  it('rejects changing the selected URI, metadata, or expected info hash', async () => {
    const f = await fixture()
    await expect(
      f.service.capture(f.taskId, { uri: `${uri}&tr=https://other.example` })
    ).rejects.toThrow('changedSource')
    await expect(
      f.service.capture(f.taskId, { uri, infoHash: '2'.repeat(40) })
    ).rejects.toThrow('changedSource')
    const ref = await f.service.capture(f.taskId, { uri })
    await expect(f.service.resolve(ref, '2'.repeat(40))).rejects.toThrow(
      'changedSource'
    )
    const bt = await fixture('bt')
    await expect(
      bt.service.capture(bt.taskId, { metadata: Buffer.from('changed') })
    ).rejects.toThrow('changedSource')
  })

  it('only captures an inactive imported task, even when its journal still exists', async () => {
    const f = await fixture()
    const pair = f.db.getTask(f.taskId)!
    Object.assign(pair.instances[0].payload.legacyImport as object, {
      activation: 'active',
    })
    f.db.saveTaskWithInstances(pair)
    await expect(f.service.capture(f.taskId, { uri })).rejects.toThrow(
      'activationSourceMissing'
    )
    f.db.deleteTask(f.taskId)
    await expect(f.service.capture(f.taskId, { uri })).rejects.toThrow(
      'activationSourceMissing'
    )
  })

  it('does not depend on a changed original profile when authorizing a new copy', async () => {
    const f = await fixture()
    await writeFile(path.join(f.profile, 'system.json'), '{}')
    const ref = await f.service.capture(f.taskId, { uri })
    expect(await f.service.resolve(ref)).toMatchObject({
      allProxy: 'http://private-user:private-pass@proxy.example:8080/',
    })
  })

  it('rejects changed torrent backup bytes independently of the original file', async () => {
    const f = await fixture('bt')
    const ref = await f.service.capture(f.taskId, { metadata: f.metadata })
    await writeFile(path.join(f.backup, 'test.torrent'), 'changed')
    await expect(f.service.resolve(ref)).rejects.toThrow('changedSource')
  })

  it.each(['system.json', 'download.session', 'user.json'])(
    'rejects tampered backup content: %s',
    async (name) => {
      const f = await fixture()
      const ref = await f.service.capture(f.taskId, { uri })
      await writeFile(path.join(f.backup, name), '{"tampered":true}')
      await expect(f.service.resolve(ref)).rejects.toThrow('changedSource')
    }
  )

  it('rejects a rewritten manifest even when its replacement file hashes agree', async () => {
    const f = await fixture()
    const ref = await f.service.capture(f.taskId, { uri })
    const bytes = Buffer.from('{"all-proxy":"http://attacker.example:8080"}')
    await writeFile(path.join(f.backup, 'system.json'), bytes)
    const manifestFile = path.join(f.backup, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.files.find(
      (file: { relativePath: string }) => file.relativePath === 'system.json'
    ).digest = digestBytes(bytes)
    await writeFile(manifestFile, JSON.stringify(manifest))
    await expect(f.service.resolve(ref)).rejects.toThrow('changedSource')
    await expect(f.service.capture(f.taskId, { uri })).rejects.toThrow(
      'changedSource'
    )
  })

  it('rejects missing backups and refuses arbitrary backup paths or extra reference fields', async () => {
    const f = await fixture()
    const ref = await f.service.capture(f.taskId, { uri })
    await expect(
      f.service.resolve({ ...ref, backupPath: f.profile } as typeof ref)
    ).rejects.toThrow('changedSource')
    await rm(f.backup, { recursive: true })
    await expect(f.service.resolve(ref)).rejects.toThrow('changedSource')
  })
})
