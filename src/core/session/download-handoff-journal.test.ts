import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LibsodiumSecretStore } from '@core/plugin/secret-store-libsodium'
import { TaskInstancePhase, TaskKind } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeInstanceRow, makeTaskRow } from '../../test-utils/task-rows'
import {
  type Activation,
  DownloadHandoffJournal,
  type HandoffKey,
  readHandoffActivationOwners,
} from './download-handoff-journal'
import { MotrixDatabase } from './motrix-database'

const payload =
  '{"headers":{"Authorization":"synthetic-test-secret"},"url":"https://files.example/file"}'
const hash = createHash('sha256').update(payload).digest('hex')
function snapshot({ taskId, engineId, saveDir }: Activation) {
  return {
    task: {
      ...makeTaskRow(taskId, TaskKind.Direct),
      saveDir,
      source: 'bridge' as const,
    },
    instances: [
      makeInstanceRow(
        randomUUID(),
        taskId,
        engineId,
        TaskInstancePhase.HttpDownload
      ),
    ],
  }
}

describe('shared Desktop and Server handoff database', () => {
  let dir: string
  let db: MotrixDatabase
  let journal: DownloadHandoffJournal
  let key: HandoffKey
  let enabled: boolean
  let time: number
  async function open() {
    db = new MotrixDatabase(path.join(dir, 'motrix.db'))
    db.init()
    const secrets = await LibsodiumSecretStore.create({ userDataDir: dir })
    journal = new DownloadHandoffJournal(
      db,
      secrets,
      () => enabled,
      () => time
    )
  }
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'motrix-handoff-'))
    enabled = true
    time = 1000
    await open()
    key = {
      instanceId: journal.instanceId,
      principal: 'extension:fixture',
      operationId: randomUUID(),
    }
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it('fences committed engine reservations without opening a secret store', async () => {
    await journal.prepare(key, payload, dir, 1000)
    const committed = await journal.commit(key, hash, snapshot)
    if (committed.state !== 'committed')
      throw new Error('expected committed handoff')
    expect(readHandoffActivationOwners(db).get(committed.taskId)).toBe(
      db.getTask(committed.taskId)?.instances[0]?.gid
    )
    db.database.exec('DROP TABLE handoff_instance')
    expect(() => readHandoffActivationOwners(db)).toThrow(
      'Incomplete handoff database'
    )
  })

  it('freezes preparation across restarts and commits the task and activation exactly once while draining', async () => {
    const first = await journal.prepare(key, payload, dir, 30000)
    if (first.state !== 'prepared') throw new Error('expected a reservation')
    expect(db.getAllTasks()).toHaveLength(0)
    expect(journal.pendingActivations()).toEqual([])
    const { sealed } = db.database
      .prepare('SELECT sealed FROM handoff_operations')
      .get() as { sealed: string }
    expect(sealed).toMatch(/^box:/)
    expect(sealed).not.toContain('synthetic-test-secret')
    db.close()
    time += 400
    enabled = false
    await open()
    expect(
      await journal.prepare(key, payload, path.join(dir, 'new-default'), 2500)
    ).toEqual(first)
    await expect(
      journal.prepare({ ...key, operationId: randomUUID() }, payload, dir, 1000)
    ).rejects.toThrow('disabled')
    const next = await journal.commit(key, hash, (intent) => {
      expect(intent.saveDir).toBe(dir)
      expect(intent.canonicalPayload).toBe(payload)
      return snapshot(intent)
    })
    expect(next).toEqual({
      state: 'committed',
      taskId: first.taskId,
      payloadHash: hash,
    })
    db.close()
    await open()
    expect(journal.status(key)).toEqual(next)
    expect(
      await journal.commit(key, hash, () => {
        throw Error('duplicate task')
      })
    ).toEqual(next)
    expect(journal.pendingActivations()).toEqual([first.taskId])
    expect(db.getTask(first.taskId)?.instances[0]?.gid).toMatch(
      /^[a-f0-9]{16}$/
    )
    expect(journal.abort(key)).toEqual(next)
    db.deleteTask(first.taskId)
    expect(journal.pendingActivations()).toEqual([])
    expect(journal.status(key)).toEqual(next)
  })
  it('rolls back both task and receipt when the activation write fails', async () => {
    const prepared = await journal.prepare(key, payload, dir, 30000)
    db.database.exec(
      "CREATE TEMP TRIGGER interrupt_activation BEFORE INSERT ON handoff_activations BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    )
    await expect(journal.commit(key, hash, snapshot)).rejects.toThrow(
      'injected failure'
    )
    expect(db.getAllTasks()).toHaveLength(0)
    expect(journal.status(key)).toEqual(prepared)
    expect(journal.pendingActivations()).toEqual([])
    db.database.exec('DROP TRIGGER interrupt_activation')
    expect((await journal.commit(key, hash, snapshot)).state).toBe('committed')
  })
  it('preserves tombstones, hash conflicts and identity isolation across restart', async () => {
    expect(journal.status(key)).toEqual({ state: 'not-found' })
    expect(journal.abort(key)).toEqual({ state: 'aborted' })
    db.close()
    await open()
    expect((await journal.prepare(key, payload, dir, 100)).state).toBe(
      'aborted'
    )
    const other = { ...key, principal: 'other-installation' }
    expect((await journal.prepare(other, payload, dir, 100)).state).toBe(
      'prepared'
    )
    await expect(
      journal.prepare(other, `${payload} `, dir, 100)
    ).rejects.toThrow('conflict')
    await expect(
      journal.commit(other, '0'.repeat(64), snapshot)
    ).rejects.toThrow('conflict')
    expect(() => journal.abort({ ...other, instanceId: randomUUID() })).toThrow(
      'mismatch'
    )
    time += 100
    expect((await journal.commit(other, hash, snapshot)).state).toBe('expired')
    expect(journal.abort(other).state).toBe('expired')
    expect(db.getAllTasks()).toHaveLength(0)
  })
  it('keeps a refused frozen directory inactive and rejects a reset instance', async () => {
    const prep = await journal.prepare(key, payload, dir, 1000)
    await expect(
      journal.commit(key, hash, () => {
        throw new Error('directory no longer permitted')
      })
    ).rejects.toThrow('no longer permitted')
    expect(journal.status(key)).toEqual(prep)
    expect(db.getAllTasks()).toHaveLength(0)
    expect(journal.pendingActivations()).toHaveLength(0)
    db.close()
    rmSync(path.join(dir, 'motrix.db'))
    await open()
    expect(journal.instanceId).not.toBe(key.instanceId)
    expect(() => journal.status(key)).toThrow('instance mismatch')
  })
  it('allows only one engine create when two recovery workers race', async () => {
    const prep = await journal.prepare(key, payload, dir, 1000)
    if (prep.state !== 'prepared') throw Error('expected reservation')
    await journal.commit(key, hash, snapshot)
    const other = new MotrixDatabase(path.join(dir, 'motrix.db'))
    other.init()
    try {
      const second = new DownloadHandoffJournal(
        other,
        await LibsodiumSecretStore.create({ userDataDir: dir }),
        () => false,
        () => time
      )
      const start = vi.fn(async (intent: Activation) => intent.engineId)
      const engine = { contains: async () => false, start }
      const outcomes = await Promise.all([
        journal.activate(prep.taskId, engine),
        second.activate(prep.taskId, engine),
      ])
      expect(outcomes).toContain('activated')
      expect(start).toHaveBeenCalledTimes(1)
      expect(second.pendingActivations()).toEqual([])
    } finally {
      other.close()
    }
  })
  it('does not evict a terminal receipt to make room for a new operation', async () => {
    const bounded = new DownloadHandoffJournal(
      db,
      await LibsodiumSecretStore.create({ userDataDir: dir }),
      () => true,
      () => time,
      1
    )
    expect(bounded.abort(key).state).toBe('aborted')
    const other = { ...key, operationId: randomUUID() }
    await expect(bounded.prepare(other, payload, dir, 1000)).rejects.toThrow(
      'full'
    )
    expect(() => bounded.abort(other)).toThrow('full')
    expect(bounded.status(other).state).toBe('not-found')
    expect((await bounded.prepare(key, payload, dir, 1000)).state).toBe(
      'aborted'
    )
  })
  it('fences delayed commits behind abort or expiry during async decryption', async () => {
    await journal.prepare(key, payload, dir, 100)
    const commit = journal.commit(key, hash, snapshot)
    journal.abort(key)
    expect((await commit).state).toBe('aborted')
    const second = { ...key, operationId: randomUUID() }
    await journal.prepare(second, payload, dir, 100)
    const late = journal.commit(second, hash, snapshot)
    time += 100
    expect((await late).state).toBe('expired')
    expect(db.getAllTasks()).toHaveLength(0)
  })
  it('reconciles an engine acknowledgement lost across restart without dispatching a second time', async () => {
    const first = await journal.prepare(key, payload, dir, 100)
    if (first.state !== 'prepared') throw Error('expected prepared')
    await journal.commit(key, hash, snapshot)
    const engineIds = new Set<string>()
    const engine = {
      contains: async (id: string) => engineIds.has(id),
      start: vi.fn(async (intent: Activation) => {
        engineIds.add(intent.engineId)
        throw Error('lost engine acknowledgement')
      }),
    }
    await expect(journal.activate(first.taskId, engine)).rejects.toThrow(
      'lost engine acknowledgement'
    )
    db.close()
    await open()
    expect(
      await journal.activate(first.taskId, {
        ...engine,
        contains: async () => false,
      })
    ).toBe('unresolved')
    expect(await journal.activate(first.taskId, engine)).toBe('activated')
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(journal.pendingActivations()).toEqual([])
  })
})
