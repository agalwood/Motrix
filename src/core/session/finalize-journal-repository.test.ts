import type { FinalizeJournalRecord } from '@core/plugin/finalize/finalize-committer'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteFinalizeJournalRepository } from './finalize-journal-repository'
import { migrate } from './migrations'

describe('SqliteFinalizeJournalRepository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
  })

  afterEach(() => db.close())

  it('persists the monotonic finalize state and all recovery identities', async () => {
    const commitTerminalBoundary = vi.fn((record: FinalizeJournalRecord) => {
      db.prepare(
        `UPDATE plugin_finalize_journals SET phase='db_committed',
         plan_json=?, updated_at=5 WHERE plan_id=? AND phase='target_installed'`
      ).run(
        JSON.stringify({ ...record, phase: 'db_committed' }),
        record.journalId
      )
    })
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary,
    })
    const record = makeRecord()

    await repository.prepare(record)
    await repository.advance(record.journalId, 'target_staged', {
      privateTargetPath: '/downloads/.private',
      privateTargetIdentity: fileIdentity('private'),
    })
    await repository.advance(record.journalId, 'target_installed', {
      targetIdentity: fileIdentity('target'),
    })
    const installed = (await repository.listRecoverable())[0]
    await repository.commitTerminal(installed)
    await repository.advance(record.journalId, 'cleaned')

    expect(commitTerminalBoundary).toHaveBeenCalledOnce()
    expect(await repository.listRecoverable()).toEqual([])
    expect(
      db
        .prepare(
          `SELECT phase, target_identity_json
         FROM plugin_finalize_journals WHERE plan_id=?`
        )
        .get(record.journalId)
    ).toEqual({
      phase: 'cleaned',
      target_identity_json: JSON.stringify(fileIdentity('target')),
    })
  })

  it('rolls the journal and terminal callback writes back on failure', async () => {
    db.exec('CREATE TABLE terminal_probe (value TEXT NOT NULL)')
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: () => {
        db.prepare(
          `INSERT INTO terminal_probe (value) VALUES ('written')`
        ).run()
        throw new Error('terminal transaction failed')
      },
    })
    const record = makeRecord('plan-rollback')
    await repository.prepare(record)
    await repository.advance(record.journalId, 'target_staged', {
      privateTargetPath: '/downloads/.private',
      privateTargetIdentity: fileIdentity('private'),
    })
    await repository.advance(record.journalId, 'target_installed', {
      targetIdentity: fileIdentity('target'),
    })

    await expect(repository.commitTerminal(record)).rejects.toThrow(
      'terminal transaction failed'
    )
    expect(
      db.prepare(`SELECT phase FROM plugin_finalize_journals`).get()
    ).toEqual({ phase: 'target_installed' })
    expect(db.prepare(`SELECT * FROM terminal_probe`).all()).toEqual([])
  })

  it('quarantines a structurally malformed recovery row', async () => {
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: vi.fn(),
    })
    const record = makeRecord('plan-corrupt')
    await repository.prepare(record)
    db.prepare(
      `UPDATE plugin_finalize_journals SET plan_json='{}' WHERE plan_id=?`
    ).run(record.journalId)

    expect(await repository.listRecoverable()).toEqual([])
    expect(
      db
        .prepare(
          `SELECT phase, quarantine_reason FROM plugin_finalize_journals
         WHERE plan_id=?`
        )
        .get(record.journalId)
    ).toMatchObject({
      phase: 'quarantined',
      quarantine_reason: expect.stringContaining('invalid persisted'),
    })
  })

  it('persists action intent without advancing the recovery phase', async () => {
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: vi.fn(),
    })
    const record = makeRecord('plan-checkpoint')

    await repository.prepare(record)
    await repository.checkpoint(record.journalId, {
      rollbackPath: '/downloads/.rollback',
      privateTargetPath: '/downloads/.private',
    })

    expect(await repository.listRecoverable()).toEqual([
      {
        ...record,
        rollbackPath: '/downloads/.rollback',
        privateTargetPath: '/downloads/.private',
      },
    ])
    expect(
      db
        .prepare(`SELECT phase FROM plugin_finalize_journals WHERE plan_id=?`)
        .get(record.journalId)
    ).toEqual({ phase: 'prepared' })
  })

  it('replaces a cleaned journal when the same task retries finalize', async () => {
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: vi.fn(),
    })
    const first = makeRecord('plan-first')
    await repository.prepare(first)
    await repository.advance(first.journalId, 'cleaned')

    const retry = makeRecord('plan-retry')
    await repository.prepare(retry)

    expect(await repository.listRecoverable()).toEqual([retry])
    expect(
      db.prepare(`SELECT plan_id FROM plugin_finalize_journals`).all()
    ).toEqual([{ plan_id: 'plan-retry' }])
  })

  it('can quarantine a committed cleanup mismatch for manual recovery', async () => {
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: vi.fn(),
    })
    const record = makeRecord('plan-committed-mismatch')
    await repository.prepare(record)
    db.prepare(
      `UPDATE plugin_finalize_journals
       SET phase='db_committed', plan_json=? WHERE plan_id=?`
    ).run(
      JSON.stringify({ ...record, phase: 'db_committed' }),
      record.journalId
    )

    await repository.quarantine(record.journalId, 'cleanup mismatch')

    expect(
      db
        .prepare(
          `SELECT phase, quarantine_reason FROM plugin_finalize_journals
           WHERE plan_id=?`
        )
        .get(record.journalId)
    ).toEqual({
      phase: 'quarantined',
      quarantine_reason: 'cleanup mismatch',
    })
  })

  it('persists and clears a committed removal intent across restart', async () => {
    const repository = new SqliteFinalizeJournalRepository(db, {
      now: () => 5,
      commitTerminalBoundary: vi.fn(),
    })
    const record = makeRecord('plan-removal-intent')
    const committed = { ...record, phase: 'db_committed' as const }
    await repository.prepare(record)
    db.prepare(
      `UPDATE plugin_finalize_journals
       SET phase='db_committed', plan_json=? WHERE plan_id=?`
    ).run(JSON.stringify(committed), record.journalId)
    const removalIntent = {
      artifactPath: '/downloads/input.part',
      quarantinePath: '/downloads/.motrix-finalize-remove-exact',
      identity: fileIdentity('source'),
    }

    await repository.checkpoint(record.journalId, { removalIntent })
    expect((await repository.listRecoverable())[0].removalIntent).toEqual(
      removalIntent
    )
    await repository.checkpoint(record.journalId, {
      removalIntent: undefined,
    })
    expect(
      (await repository.listRecoverable())[0].removalIntent
    ).toBeUndefined()
  })
})

function makeRecord(journalId = 'plan-1'): FinalizeJournalRecord {
  return {
    journalId,
    phase: 'prepared',
    plan: {
      planId: journalId,
      taskId: 'task-1',
      saveDir: '/downloads',
      sourcePath: '/downloads/input.part',
      targetPath: '/downloads/output.bin',
      sourceIdentity: fileIdentity('source'),
      metadataOps: [],
      contributors: [],
    },
  }
}

function fileIdentity(seed: string) {
  return {
    kind: 'file' as const,
    size: seed.length,
    sha256: seed.padEnd(64, '0'),
    platformFileId: `device:${seed}`,
  }
}
