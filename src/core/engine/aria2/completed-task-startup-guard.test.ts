// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompletedTaskStartupGuard,
  parseSessionRunIntent,
} from './completed-task-startup-guard'

const DONE = '1111111111111111'
const RUN = '2222222222222222'
const PAUSED = '3333333333333333'
const entry = (gid: string, paused = false) =>
  `http://127.0.0.1/file\n gid=${gid}\n${paused ? ' pause=true\n' : ''}`
const folders: string[] = []

async function setup(sqlite = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'completed-startup-'))
  folders.push(dir)
  const session = path.join(dir, 'aria2.session')
  const source = sqlite ? path.join(dir, 'aria2.db') : session
  const content = entry(DONE) + entry(RUN) + entry(PAUSED, true)
  if (sqlite) {
    const db = new Database(source)
    db.exec(
      'CREATE TABLE task(gid TEXT, state TEXT, serialized TEXT, queue_position INTEGER)'
    )
    for (const [index, gid] of [DONE, RUN, PAUSED].entries())
      db.prepare('INSERT INTO task VALUES (?, ?, ?, ?)').run(
        gid,
        gid === PAUSED ? 'paused' : 'waiting',
        entry(gid, gid === PAUSED),
        index
      )
    db.close()
  } else await writeFile(source, content)
  const rpc = {
    tellStatus: vi.fn(async (_gid: string) => ({ status: 'paused' }) as never),
    forceRemove: vi.fn(async (gid: string) => gid),
    unpause: vi.fn(async (gid: string) => gid),
    changeGlobalOption: vi.fn(async () => 'OK' as const),
  }
  const removeResult = vi.fn(async (_gid: string) => {})
  const completedGids = () => new Set([DONE])
  const guard = new CompletedTaskStartupGuard({
    completedGids,
    rpc,
    removeResult,
  })
  const args = [
    `--save-session=${session}`,
    '--pause=false',
    ...(sqlite
      ? ['--enable-sqlite3-persistence=true', `--sqlite3-db-path=${source}`]
      : [`--input-file=${source}`]),
  ]
  return {
    source,
    args,
    rpc,
    removeResult,
    guard,
    journal: `${session}.completed-recovery.json`,
  }
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('CompletedTaskStartupGuard', () => {
  it.each([false, true])(
    'purges completed rows before resuming only originally running tasks (sqlite=%s)',
    async (sqlite) => {
      const h = await setup(sqlite)
      const prepared = await h.guard.prepare(h.args)
      expect(prepared?.args).toContain('--pause=true')
      expect(prepared?.args).not.toContain('--pause=false')
      const journal = JSON.parse(await readFile(h.journal, 'utf8'))
      expect(journal.resume).toEqual([DONE, RUN])
      await prepared?.reconcile(() => false)
      expect(h.removeResult).toHaveBeenCalledWith(DONE)
      expect(h.rpc.unpause).toHaveBeenCalledExactlyOnceWith(RUN)
      expect(h.removeResult.mock.invocationCallOrder[0]).toBeLessThan(
        h.rpc.unpause.mock.invocationCallOrder[0]!
      )
      await expect(readFile(h.journal)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  it('does not pause ordinary startup without a matching completed session GID', async () => {
    const h = await setup()
    // Unrelated custom input must not be rejected when no barrier is needed.
    await writeFile(
      h.source,
      `${entry(RUN)} pause=false\nhttp://example.test/no-gid\n`
    )
    expect(await h.guard.prepare(h.args)).toBeNull()
  })

  it('preserves original run intent after a crash in a paused startup', async () => {
    const h = await setup()
    await h.guard.prepare(h.args)
    // The interrupted engine saved every temporarily held task as paused.
    await writeFile(
      h.source,
      entry(DONE, true) + entry(RUN, true) + entry(PAUSED, true)
    )
    const again = await h.guard.prepare(h.args)
    await again?.reconcile(() => false)
    expect(h.rpc.unpause).toHaveBeenCalledExactlyOnceWith(RUN)
  })

  it('keeps all tasks held and retains recovery intent if purge fails', async () => {
    const h = await setup()
    h.removeResult.mockRejectedValue(new Error('database busy'))
    const prepared = await h.guard.prepare(h.args)
    await expect(prepared?.reconcile(() => false)).rejects.toThrow(
      'database busy'
    )
    expect(h.rpc.unpause).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(h.journal, 'utf8')).resume).toEqual([
      DONE,
      RUN,
    ])
  })

  it('does not resume or discard the journal during shutdown', async () => {
    const h = await setup()
    const prepared = await h.guard.prepare(h.args)
    await prepared?.reconcile(() => true)
    expect(h.rpc.unpause).not.toHaveBeenCalled()
    expect(await readFile(h.journal, 'utf8')).toContain(RUN)
  })

  it('fails closed if a pending journal would cross to a different session', async () => {
    const h = await setup()
    await h.guard.prepare(h.args)
    await expect(
      h.guard.prepare(
        h.args.map((arg) =>
          arg.startsWith('--input-file=') ? `${arg}.other` : arg
        )
      )
    ).rejects.toThrow('different engine session')
  })

  it('rejects an explicit per-task pause=false which would bypass the barrier', () => {
    expect(() => parseSessionRunIntent(`${entry(DONE)} pause=false\n`)).toThrow(
      'pause barrier'
    )
  })

  it('rejects missing or duplicate GIDs without logging URL-bearing input', () => {
    expect(() => parseSessionRunIntent('http://secret.example/file\n')).toThrow(
      'Ambiguous engine session identity'
    )
    expect(() => parseSessionRunIntent(entry(DONE) + entry(DONE))).toThrow(
      'Ambiguous engine session identity'
    )
  })
})
