import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { SqliteFinalizeJournalRepository } from '@core/session/finalize-journal-repository'
import { migrate } from '@core/session/migrations'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FinalizeFsError,
  NativeFinalizeFilesystemAdapter,
} from './filesystem-adapter'
import type { FinalizeJournalRecord } from './finalize-committer'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    path.join(
      'packages/finalize-fs/target/debug',
      process.platform === 'win32'
        ? 'motrix-finalize-fs.exe'
        : 'motrix-finalize-fs'
    )
)

describe.runIf(existsSync(binary))('SMB finalize failure recovery', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const dispose of cleanup.splice(0)) await dispose()
  })

  async function setup() {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'motrix-smb-recovery-'))
    )
    const adapter = new NativeFinalizeFilesystemAdapter(binary)
    const fs = new NativeFinalizeArtifactOperations(adapter)
    const db = new Database(':memory:')
    migrate(db)
    cleanup.push(async () => {
      await adapter.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    })
    const sourcePath = path.join(root, 'download.bin.motrix')
    const targetPath = path.join(root, 'download.bin')
    await writeFile(sourcePath, 'complete download')
    const input = {
      task: makeDownloadTask({
        id: 'task-smb',
        saveDir: root,
        diskPath: sourcePath,
        finalPath: targetPath,
      }),
      occurrence: null,
      sourcePath,
      targetPath,
      metadataOps: [],
      contributors: [],
      postDeliveries: [],
    }
    const runtime = new DurableFinalizeRuntime({
      db,
      fs,
      session: {
        persistFinalizedArtifact: async (
          _task,
          _occurrence,
          _effects,
          commit
        ) =>
          commit((journal) => {
            const raw = db
              .prepare(
                'SELECT plan_json FROM plugin_finalize_journals WHERE plan_id=?'
              )
              .get(journal.journalId) as { plan_json: string }
            db.prepare(
              "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=? WHERE plan_id=?"
            ).run(
              JSON.stringify({
                ...JSON.parse(raw.plan_json),
                phase: 'db_committed',
              }),
              journal.journalId
            )
          }),
      },
    })
    const repository = new SqliteFinalizeJournalRepository(db, {
      commitTerminalBoundary: () => {
        throw new Error('not used')
      },
    })
    const row = () =>
      db
        .prepare(
          'SELECT phase, quarantine_reason FROM plugin_finalize_journals'
        )
        .get()
    async function legacyJournal(targetInstalled = false) {
      const sourceIdentity = await fs.identity(sourcePath)
      if (!sourceIdentity) throw new Error('missing fixture')
      const record: FinalizeJournalRecord = {
        journalId: 'legacy-plan',
        phase: 'prepared',
        publicationMode: 'move',
        plan: {
          planId: 'legacy-plan',
          taskId: input.task.id,
          saveDir: root,
          sourcePath,
          targetPath,
          sourceIdentity,
          metadataOps: [],
          contributors: [],
        },
      }
      await repository.prepare(record)
      if (targetInstalled)
        await fs.moveNoReplace(sourcePath, sourceIdentity, targetPath)
      await repository.quarantine(
        record.journalId,
        'compensation failed after FinalizeFsError: Incorrect function. (os error 1): FinalizeFsError: Incorrect function. (os error 1)'
      )
      return record
    }
    return {
      adapter,
      db,
      fs,
      root,
      runtime,
      repository,
      input,
      row,
      legacyJournal,
    }
  }

  it('rejects unsupported roots before creating a journal or renaming the download', async () => {
    const s = await setup()
    vi.spyOn(s.adapter, 'syncRoot').mockRejectedValue(
      new FinalizeFsError('unsupported', 'directory flush unsupported')
    )
    const rename = vi.spyOn(s.adapter, 'renameOpenedNoReplace')
    await expect(s.runtime.commit(s.input)).rejects.toThrow(
      'directory flush unsupported'
    )
    expect(s.row()).toBeUndefined()
    expect(rename).not.toHaveBeenCalled()
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
  })

  it('retains both I/O errors and retries a failed rollback without restarting', async () => {
    const s = await setup()
    const realSync = s.adapter.syncRoot.bind(s.adapter)
    let calls = 0
    const injected = vi
      .spyOn(s.adapter, 'syncRoot')
      .mockImplementation(async (root) => {
        if (++calls >= 3)
          throw new FinalizeFsError('io_error', `sync failure ${calls}`)
        await realSync(root)
      })
    const rename = vi.spyOn(s.adapter, 'renameOpenedNoReplace')
    const failure = await s.runtime
      .commit(s.input)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'FinalizeFsError: sync failure 3',
      'FinalizeFsError: sync failure 4',
    ])
    expect(rename).toHaveBeenCalledTimes(2)
    expect(s.row()).toMatchObject({
      phase: 'prepared',
      quarantine_reason: null,
    })
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
    injected.mockRestore()
    await s.runtime.commit(s.input)
    expect(s.row()).toMatchObject({ phase: 'cleaned' })
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('complete download')
    expect(existsSync(s.input.sourcePath)).toBe(false)
  })

  it.each([false, true])(
    'recovers a legacy quarantine with targetInstalled=%s before task restore',
    async (installed) => {
      const s = await setup()
      await s.legacyJournal(installed)
      await s.runtime.recoverAll()
      expect(s.row()).toMatchObject({
        phase: 'cleaned',
        quarantine_reason: null,
      })
      expect(await readFile(s.input.sourcePath, 'utf8')).toBe(
        'complete download'
      )
      expect(existsSync(s.input.targetPath)).toBe(false)
      await s.runtime.commit(s.input)
      expect(await readFile(s.input.targetPath, 'utf8')).toBe(
        'complete download'
      )
    }
  )

  it('recovers the old quarantine on explicit retry without a restart', async () => {
    const s = await setup()
    await s.legacyJournal(true)
    await s.runtime.commit(s.input)
    expect(s.row()).toMatchObject({ phase: 'cleaned' })
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('complete download')
  })

  it.each(['both', 'replaced', 'missing', 'identity-quarantine', 'malformed'])(
    'preserves unsafe old journals: %s',
    async (state) => {
      const s = await setup()
      const record = await s.legacyJournal()
      if (state === 'both')
        await writeFile(s.input.targetPath, 'unrelated target')
      if (state === 'replaced')
        await writeFile(s.input.sourcePath, 'changed source')
      if (state === 'missing') await rm(s.input.sourcePath)
      if (state === 'identity-quarantine')
        await s.repository.quarantine(
          record.journalId,
          'compensation target identity mismatch'
        )
      if (state === 'malformed')
        s.db.prepare("UPDATE plugin_finalize_journals SET plan_json='{}'").run()
      const rename = vi.spyOn(s.adapter, 'renameOpenedNoReplace')
      await s.runtime.recoverAll()
      expect(s.row()).toMatchObject({ phase: 'quarantined' })
      expect(rename).not.toHaveBeenCalled()
      if (state === 'both')
        expect(await readFile(s.input.targetPath, 'utf8')).toBe(
          'unrelated target'
        )
      if (state === 'replaced')
        expect(await readFile(s.input.sourcePath, 'utf8')).toBe(
          'changed source'
        )
    }
  )

  it('does not reopen a legacy quarantine while the share is offline', async () => {
    const s = await setup()
    await s.legacyJournal()
    vi.spyOn(s.fs, 'identity').mockRejectedValue(
      Object.assign(new Error('share offline'), { code: 'EIO' })
    )
    await expect(s.runtime.recoverAll()).rejects.toThrow(
      'one or more finalize journals failed'
    )
    expect(s.row()).toMatchObject({ phase: 'quarantined' })
  })
})
