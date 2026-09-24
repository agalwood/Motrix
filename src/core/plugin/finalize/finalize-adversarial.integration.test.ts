import { existsSync } from 'node:fs'
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SqliteFinalizeJournalRepository } from '@core/session/finalize-journal-repository'
import { migrate } from '@core/session/migrations'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  artifactContentEquals,
  artifactIdentityEquals,
} from './artifact-identity'
import { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'
import {
  FinalizeFsError,
  NativeFinalizeFilesystemAdapter,
} from './filesystem-adapter'
import {
  FinalizeCommitter,
  type FinalizeJournalRecord,
  prepareRemovalIntent,
} from './finalize-committer'
import { FinalizeRecovery } from './finalize-recovery'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    'packages/finalize-fs/target/debug/motrix-finalize-fs'
)
const nfsRoot = process.env.MOTRIX_FINALIZE_NFS_ROOT
if (nfsRoot && (process.platform !== 'linux' || !existsSync(binary))) {
  throw new Error('NFS contract requires Linux and a built native sidecar')
}
describe.runIf(process.platform !== 'win32' && existsSync(binary))(
  'finalize adversarial recovery',
  { timeout: 30_000 },
  () => {
    const cleanup: (() => Promise<void>)[] = []
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const dispose of cleanup.splice(0)) await dispose()
    }, 30_000)

    async function setup() {
      if (nfsRoot) expect((await statfs(nfsRoot)).type).toBe(0x6969)
      const local = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'motrix-adversarial-db-'))
      )
      const root = await realpath(
        await mkdtemp(path.join(nfsRoot ?? local, 'motrix-adversarial-'))
      )
      const sourcePath = path.join(root, 'file.motrix')
      const targetPath = path.join(root, 'file.bin')
      await writeFile(sourcePath, 'the only complete payload')
      const adapter = new NativeFinalizeFilesystemAdapter(binary)
      const fs = new NativeFinalizeArtifactOperations(adapter)
      const db = new Database(path.join(local, 'journal.sqlite'))
      migrate(db)
      const repository = new SqliteFinalizeJournalRepository(db, {
        commitTerminalBoundary: () => {
          throw new Error('not used')
        },
      })
      const identity = (await fs.identity(sourcePath))!
      const plan = {
        planId: 'adversarial-plan',
        taskId: 'adversarial-task',
        saveDir: root,
        sourcePath,
        targetPath,
        sourceIdentity: identity,
        metadataOps: [],
        contributors: [],
      }
      const recovery = new FinalizeRecovery({
        fs,
        repository,
        leases: new ArtifactMutationLeaseCoordinator([]),
        exactIdentity: artifactIdentityEquals,
        sameContent: artifactContentEquals,
        rollForwardTargetInstalled: false,
      })
      cleanup.push(async () => {
        await adapter.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
        await rm(local, { recursive: true, force: true })
      })
      return { root, plan, adapter, fs, db, repository, recovery, identity }
    }

    it.each(['before_isolation', 'after_isolation'] as const)(
      'rollback must preserve its only surviving payload after %s',
      async (point) => {
        const s = await setup()
        await link(s.plan.sourcePath, s.plan.targetPath)
        const record: FinalizeJournalRecord = {
          journalId: s.plan.planId,
          phase: 'prepared',
          plan: s.plan,
          publicationMode: 'move',
          publicationIntent: {
            version: 1,
            method: 'hard_link',
            sourcePath: s.plan.sourcePath,
            identity: s.identity,
            confirmed: true,
          },
        }
        await s.repository.prepare(record)
        const removalIntent = await prepareRemovalIntent(
          s.fs,
          record.journalId,
          s.plan.targetPath,
          s.identity
        )
        await s.repository.checkpoint(record.journalId, { removalIntent })
        if (point === 'after_isolation') {
          const remove = vi
            .spyOn(s.adapter, 'removeOpened')
            .mockRejectedValueOnce(new Error('crash before unlink'))
          await expect(
            s.fs.removeKnown(
              removalIntent.artifactPath,
              removalIntent.identity,
              removalIntent.quarantinePath,
              removalIntent.isolation
            )
          ).rejects.toThrow('crash before unlink')
          remove.mockRestore()
        }
        // Another client removes the original name during the interruption.
        await unlink(s.plan.sourcePath)
        const lastName =
          point === 'before_isolation'
            ? s.plan.targetPath
            : removalIntent.quarantinePath
        expect(await readFile(lastName, 'utf8')).toBe(
          'the only complete payload'
        )
        const [persisted] = await s.repository.listRecoverable()
        await expect(s.recovery.recover(persisted)).rejects.toThrow(
          'quarantined'
        )
        const survivors = [
          s.plan.sourcePath,
          s.plan.targetPath,
          removalIntent.quarantinePath,
        ].filter(existsSync)
        expect(survivors.length).toBeGreaterThan(0)
      }
    )

    it.each(['before_clear', 'after_clear'] as const)(
      'finishes an interrupted copy rollback after private unlink (%s)',
      async (point) => {
        const s = await setup()
        const privateTargetPath = path.join(s.root, '.private-copy')
        const privateTargetIdentity = await s.fs.materializePrivate(
          s.plan.sourcePath,
          s.identity,
          privateTargetPath
        )
        await link(privateTargetPath, s.plan.targetPath)
        const record: FinalizeJournalRecord = {
          journalId: s.plan.planId,
          phase: 'prepared',
          plan: s.plan,
          publicationMode: 'copy',
          privateTargetPath,
          privateTargetIdentity,
          publicationIntent: {
            version: 1,
            method: 'hard_link',
            sourcePath: privateTargetPath,
            identity: privateTargetIdentity,
            confirmed: true,
          },
        }
        await s.repository.prepare(record)
        await s.repository.advance(record.journalId, 'target_staged')
        // The verified public link has already been rolled back.
        await unlink(s.plan.targetPath)
        const intent = await prepareRemovalIntent(
          s.fs,
          record.journalId,
          privateTargetPath,
          privateTargetIdentity
        )
        await s.repository.checkpoint(record.journalId, {
          removalIntent: intent,
        })
        await s.fs.removeKnown(
          intent.artifactPath,
          intent.identity,
          intent.quarantinePath,
          intent.isolation,
          { path: s.plan.sourcePath, identity: s.identity }
        )
        if (point === 'after_clear')
          await s.repository.checkpoint(record.journalId, {
            removalIntent: undefined,
          })
        await s.recovery.recoverAll()
        expect(
          s.db.prepare('SELECT phase FROM plugin_finalize_journals').get()
        ).toEqual({ phase: 'cleaned' })
        expect(await readFile(s.plan.sourcePath, 'utf8')).toBe(
          'the only complete payload'
        )
        expect(existsSync(s.plan.targetPath)).toBe(false)
        expect(existsSync(privateTargetPath)).toBe(false)
      }
    )

    it('must preserve a competing hard link when publication gets EEXIST', async () => {
      const s = await setup()
      vi.spyOn(s.fs, 'moveNoReplace').mockRejectedValue(
        new FinalizeFsError('rename_unsupported', 'NFS NOREPLACE')
      )
      const realLink = s.fs.linkNoReplace.bind(s.fs)
      vi.spyOn(s.fs, 'linkNoReplace').mockImplementationOnce(
        async (source, _expected, target) => {
          // A competing process wins after our target-absent check.
          await link(source, target)
          const competitorLink = await s.fs.identity(target)
          expect(artifactIdentityEquals(competitorLink!, s.identity)).toBe(true)
          if (process.platform === 'linux')
            return realLink(source, _expected, target)
          try {
            await link(source, target)
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe('EEXIST')
            throw new FinalizeFsError('target_exists', 'linkat: File exists', {
              osError: 17,
              operation: 'link_opened_no_replace',
            })
          }
        }
      )
      const committer = new FinalizeCommitter({
        fs: s.fs,
        repository: s.repository,
        leases: new ArtifactMutationLeaseCoordinator([]),
        exactIdentity: artifactIdentityEquals,
        sameContent: artifactContentEquals,
        privatePathFor: () => path.join(s.root, '.private'),
        rollbackPathFor: () => path.join(s.root, '.rollback'),
      })
      await expect(committer.commit(s.plan)).rejects.toThrow(
        'ownership is unconfirmed'
      )
      expect(existsSync(s.plan.targetPath)).toBe(true)
    })

    it.each(['missing', 'replaced'] as const)(
      'preserves the isolated payload when the survivor becomes %s at native deletion',
      async (mutation) => {
        const s = await setup()
        // A cross-device copy has a distinct inode: removing its name cannot
        // incidentally trip the held source's ctime validation.
        await writeFile(s.plan.targetPath, 'the only complete payload')
        const record: FinalizeJournalRecord = {
          journalId: s.plan.planId,
          phase: 'prepared',
          plan: s.plan,
          publicationMode: 'copy',
          targetIdentity: (await s.fs.identity(s.plan.targetPath))!,
        }
        await s.repository.prepare(record)
        s.db
          .prepare(
            "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=?"
          )
          .run(JSON.stringify({ ...record, phase: 'db_committed' }))
        const remove = s.adapter.removeOpened.bind(s.adapter)
        vi.spyOn(s.adapter, 'removeOpened').mockImplementationOnce(
          async (...args) => {
            expect(args[3]).toBeDefined()
            await unlink(s.plan.targetPath)
            if (mutation === 'replaced')
              await writeFile(s.plan.targetPath, 'competitor')
            return remove(...args)
          }
        )
        const [persisted] = await s.repository.listRecoverable()
        await expect(s.recovery.recover(persisted)).rejects.toThrow()
        const [pending] = await s.repository.listRecoverable()
        expect(
          await readFile(pending.removalIntent!.quarantinePath, 'utf8')
        ).toBe('the only complete payload')
        await s.recovery.recoverAll()
        expect(
          s.db
            .prepare(
              'SELECT phase, quarantine_reason FROM plugin_finalize_journals'
            )
            .get()
        ).toEqual({
          phase: 'quarantined',
          quarantine_reason: 'committed target identity mismatch',
        })
        expect(
          await readFile(pending.removalIntent!.quarantinePath, 'utf8')
        ).toBe('the only complete payload')
        if (mutation === 'replaced')
          expect(await readFile(s.plan.targetPath, 'utf8')).toBe('competitor')
      }
    )

    it('should restart a dead sidecar while resuming journaled private cleanup', async () => {
      const s = await setup()
      await link(s.plan.sourcePath, s.plan.targetPath)
      const record: FinalizeJournalRecord = {
        journalId: s.plan.planId,
        phase: 'prepared',
        plan: s.plan,
        publicationMode: 'move',
        publicationIntent: {
          version: 1,
          method: 'hard_link',
          sourcePath: s.plan.sourcePath,
          identity: s.identity,
          confirmed: true,
        },
      }
      await s.repository.prepare(record)
      await s.repository.advance(record.journalId, 'target_installed', {
        targetIdentity: s.identity,
      })
      const committed = {
        ...record,
        phase: 'db_committed',
        targetIdentity: s.identity,
      }
      s.db
        .prepare(
          "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=?"
        )
        .run(JSON.stringify(committed))
      const intent = await prepareRemovalIntent(
        s.fs,
        record.journalId,
        s.plan.sourcePath,
        s.identity
      )
      await s.repository.checkpoint(record.journalId, { removalIntent: intent })
      const child = (
        s.adapter as unknown as {
          child: import('node:child_process').ChildProcess
        }
      ).child
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
      await s.recovery.recoverAll()
      expect(existsSync(s.plan.sourcePath)).toBe(false)
      expect(await readFile(s.plan.targetPath, 'utf8')).toBe(
        'the only complete payload'
      )
    })
  }
)
