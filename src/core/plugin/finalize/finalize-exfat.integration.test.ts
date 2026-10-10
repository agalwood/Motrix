// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { SqliteFinalizeJournalRepository } from '@core/session/finalize-journal-repository'
import { migrate } from '@core/session/migrations'
import {
  defaultRecoveryFs,
  TaskRecoveryServiceImpl,
} from '@core/task/task-recovery-service'
import { TaskStatus, TransitionPhase } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FinalizeFsError,
  NativeFinalizeFilesystemAdapter,
} from './filesystem-adapter'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'
import { reservationMarker } from './reserved-identity'

const volume = process.env.MOTRIX_FINALIZE_EXFAT_ROOT
// Set only by the disposable-image harness; never detach a user-supplied volume.
const image = process.env.MOTRIX_FINALIZE_EXFAT_TEST_IMAGE
// Disk Arbitration can take several seconds per attach/detach on CI runners.
const diskImageCommandOptions = { timeout: 20_000 }
const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    'packages/finalize-fs/target/debug/motrix-finalize-fs'
)

describe.runIf(
  process.platform === 'darwin' && Boolean(volume) && existsSync(binary)
)('macOS exFAT publication and recovery', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  async function setup(content = 'complete download', name = '下载.bin') {
    const root = await realpath(
      await mkdtemp(path.join(volume as string, 'motrix-exfat-'))
    )
    const local = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'motrix-exfat-db-'))
    )
    const dbPath = path.join(local, 'journal.sqlite')
    const sourcePath = path.join(root, `${name}.motrix`)
    const targetPath = path.join(root, name)
    await writeFile(sourcePath, content)
    let commits = 0
    const input = {
      task: makeDownloadTask({
        id: 'exfat-download',
        saveDir: root,
        diskPath: sourcePath,
        finalPath: targetPath,
        status: TaskStatus.Finalizing,
        transitionPhase: TransitionPhase.Renaming,
      }),
      occurrence: null,
      sourcePath,
      targetPath,
      contributors: [],
      metadataOps: [],
      postDeliveries: [],
    }
    const connect = () => {
      const db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      migrate(db)
      const adapter = new NativeFinalizeFilesystemAdapter(binary)
      const fs = new NativeFinalizeArtifactOperations(adapter)
      const runtime = new DurableFinalizeRuntime({
        db,
        fs,
        session: {
          persistFinalizedArtifact: async (
            _task,
            _occurrence,
            _effects,
            install
          ) =>
            install((journal) => {
              expect(db.pragma('synchronous', { simple: true })).toBe(2)
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
              commits++
            }),
        },
      })
      cleanup.push(async () => {
        await adapter.dispose()
        if (db.open) db.close()
      })
      return { db, adapter, fs, runtime }
    }
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true })
      await rm(local, { recursive: true, force: true })
    })
    const s = connect()
    const row = () =>
      s.db
        .prepare(
          'SELECT phase, plan_json, quarantine_reason FROM plugin_finalize_journals'
        )
        .get() as
        | { phase: string; plan_json: string; quarantine_reason: string | null }
        | undefined
    const requireCompatibility = () =>
      vi.spyOn(s.adapter, 'renameOpenedNoReplace').mockRejectedValue(
        new FinalizeFsError(
          'rename_unsupported',
          'exclusive rename unsupported',
          {
            operation: 'rename_opened_no_replace',
            osError: 45,
            mutation: 'unknown',
          }
        )
      )
    const restart = async () => {
      await s.adapter.dispose()
      if (s.db.open) s.db.close()
      Object.assign(s, connect())
    }
    const recoverViaTaskService = async () => {
      const service = new TaskRecoveryServiceImpl({
        taskManager: { getAll: () => [input.task], persist: vi.fn() },
        adapter: { listActiveAndWaiting: async () => [] },
        fs: defaultRecoveryFs,
        hasPendingFinalization: (id) => s.runtime.hasPendingFinalization(id),
        finalizeTask: async () => {
          await s.runtime.commit(input)
        },
        activityRecorder: {
          recordSubmitted: vi.fn(),
          recordDownloadCompleted: vi.fn(),
        },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      })
      const report = await service.recoverOnStartup()
      expect(report.errors).toEqual([])
      expect(report.recovered).toHaveLength(1)
    }
    return {
      ...s,
      connection: s,
      root,
      local,
      dbPath,
      input,
      row,
      restart,
      recoverViaTaskService,
      requireCompatibility,
      commits: () => commits,
    }
  }

  it.each(
    ['', 'complete download', 'x'.repeat(1024 * 1024)].map((content) => ({
      content,
      bytes: content.length,
    }))
  )('finishes real suffix removal ($bytes bytes)', async ({ content }) => {
    const s = await setup(content)
    const before = await s.fs.identity(s.input.sourcePath)
    const copy = vi.spyOn(s.adapter, 'copyOpened')
    const result = await s.runtime.commit(s.input)
    expect(await readFile(s.input.targetPath, 'utf8')).toBe(content)
    expect(existsSync(s.input.sourcePath)).toBe(false)
    expect(result.targetIdentity).toEqual(
      await s.fs.identity(s.input.targetPath)
    )
    expect(result.targetIdentity.kind).toBe(before?.kind)
    expect(s.row()?.phase).toBe('cleaned')
    expect(s.commits()).toBe(1)
    expect(copy).not.toHaveBeenCalled()
    expect(s.db.pragma('synchronous', { simple: true })).toBe(1)
  })

  it('preserves an existing target without creating a reservation', async () => {
    const s = await setup()
    await writeFile(s.input.targetPath, 'unrelated file')
    const reserve = vi.spyOn(s.adapter, 'reserveExfatTarget')
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('unrelated file')
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
    expect(reserve).not.toHaveBeenCalled()
  })

  it('refuses a reservation replaced before the native identity check', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = s.adapter.renameOpenedReserved.bind(s.adapter)
    vi.spyOn(s.adapter, 'renameOpenedReserved').mockImplementation(
      async (...args) => {
        await rename(s.input.targetPath, path.join(s.root, 'old-reservation'))
        await writeFile(s.input.targetPath, 'competing writer')
        return real(...args)
      }
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(s.row()?.phase).toBe('quarantined')
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('competing writer')
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
  })

  it('recovers a lost reservation response using its pre-journaled token', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = s.adapter.reserveExfatTarget.bind(s.adapter)
    vi.spyOn(s.adapter, 'reserveExfatTarget').mockImplementation(
      async (...args) => {
        await real(...args)
        throw new Error('lost reservation response')
      }
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(s.row()?.phase).toBe('prepared')
    const intent = JSON.parse(s.row()!.plan_json).publicationIntent
    expect(await readFile(s.input.targetPath)).toEqual(
      reservationMarker(intent.ownership.token)
    )
    await s.restart()
    await s.recoverViaTaskService()
    expect(s.row()?.phase).toBe('cleaned')
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('complete download')
    expect(existsSync(s.input.sourcePath)).toBe(false)
  })

  it('resumes a journaled reservation after reopening the database and sidecar', async () => {
    const s = await setup()
    s.requireCompatibility()
    vi.spyOn(s.adapter, 'renameOpenedReserved').mockRejectedValue(
      new Error('stopped before rename')
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow(
      'stopped before rename'
    )
    expect(s.row()?.phase).toBe('prepared')
    await s.restart()
    await s.connection.runtime.recoverAll()
    expect(s.row()?.phase).toBe('prepared')
    await s.recoverViaTaskService()
    expect(s.row()?.phase).toBe('cleaned')
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('complete download')
    expect(existsSync(s.input.sourcePath)).toBe(false)
    expect(s.commits()).toBe(1)
  })

  it('recovers a lost successful rename response without replay or rollback', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = s.adapter.renameOpenedReserved.bind(s.adapter)
    vi.spyOn(s.adapter, 'renameOpenedReserved').mockImplementation(
      async (...args) => {
        await real(...args)
        throw new Error('lost rename response')
      }
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow(
      'lost rename response'
    )
    expect(s.row()?.phase).toBe('target_installed')
    await s.restart()
    await s.connection.runtime.recoverAll()
    expect(s.row()?.phase).toBe('target_installed')
    const renameAgain = vi.spyOn(s.connection.adapter, 'renameOpenedReserved')
    await s.recoverViaTaskService()
    expect(renameAgain).not.toHaveBeenCalled()
    expect(s.row()?.phase).toBe('cleaned')
    expect(s.commits()).toBe(1)
  })

  it('keeps an installed empty file when its acknowledged identity precedes a later sync failure', async () => {
    const s = await setup('')
    s.requireCompatibility()
    const real = s.fs.makeDurable.bind(s.fs)
    vi.spyOn(s.fs, 'makeDurable').mockImplementation(async (file) => {
      if (file === s.input.targetPath)
        throw new Error('post-install sync failed')
      return real(file)
    })
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(s.row()?.phase).toBe('prepared')
    expect(JSON.parse(s.row()!.plan_json).targetIdentity).toEqual(
      await s.fs.identity(s.input.targetPath)
    )
    await s.restart()
    await s.connection.runtime.recoverAll()
    await s.connection.runtime.commit(s.input)
    expect(s.row()?.phase).toBe('cleaned')
    expect(await readFile(s.input.targetPath)).toHaveLength(0)
  })

  it('does not rename after the reservation checkpoint fails', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = SqliteFinalizeJournalRepository.prototype.checkpoint
    vi.spyOn(
      SqliteFinalizeJournalRepository.prototype,
      'checkpoint'
    ).mockImplementation(async function (
      this: SqliteFinalizeJournalRepository,
      id,
      patch
    ) {
      if (
        patch.publicationIntent?.method === 'reserved_rename' &&
        patch.publicationIntent.reservationIdentity
      )
        throw new Error('reservation checkpoint failed')
      return real.call(this, id, patch)
    })
    const renameReserved = vi.spyOn(s.adapter, 'renameOpenedReserved')
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(renameReserved).not.toHaveBeenCalled()
    expect(existsSync(s.input.sourcePath)).toBe(true)
    expect(await readFile(s.input.targetPath)).toEqual(
      reservationMarker(
        JSON.parse(s.row()!.plan_json).publicationIntent.ownership.token
      )
    )
  })

  it('preserves a target created between the unsupported rename and reservation', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = s.adapter.reserveExfatTarget.bind(s.adapter)
    vi.spyOn(s.adapter, 'reserveExfatTarget').mockImplementation(
      async (...args) => {
        await writeFile(s.input.targetPath, 'concurrent download')
        return real(...args)
      }
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    expect(await readFile(s.input.targetPath, 'utf8')).toBe(
      'concurrent download'
    )
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
  })

  it('does not infer an unacknowledged empty-file identity transition from equal content', async () => {
    const s = await setup('')
    const before = await s.fs.identity(s.input.sourcePath)
    s.requireCompatibility()
    const real = s.adapter.renameOpenedReserved.bind(s.adapter)
    vi.spyOn(s.adapter, 'renameOpenedReserved').mockImplementation(
      async (...args) => {
        await real(...args)
        throw new Error('lost empty-file rename response')
      }
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    const after = await s.fs.identity(s.input.targetPath)
    expect(s.row()?.phase).toBe(
      before?.platformFileId === after?.platformFileId
        ? 'target_installed'
        : 'quarantined'
    )
    expect(existsSync(s.input.sourcePath)).toBe(false)
    expect(await readFile(s.input.targetPath)).toHaveLength(0)
    expect(s.commits()).toBe(0)
  })

  it('retries a failed terminal transaction without replaying publication', async () => {
    const s = await setup()
    s.requireCompatibility()
    const real = SqliteFinalizeJournalRepository.prototype.commitTerminal
    const failure = vi
      .spyOn(SqliteFinalizeJournalRepository.prototype, 'commitTerminal')
      .mockRejectedValue(new Error('database unavailable'))
    await expect(s.runtime.commit(s.input)).rejects.toThrow(
      'database unavailable'
    )
    expect(s.row()?.phase).toBe('target_installed')
    failure.mockImplementation(real)
    const renameAgain = vi.spyOn(s.adapter, 'renameOpenedReserved')
    await s.recoverViaTaskService()
    expect(renameAgain).not.toHaveBeenCalled()
    expect(s.row()?.phase).toBe('cleaned')
    expect(s.commits()).toBe(1)
  })

  it('revalidates the installed target after recovery flushes before committing', async () => {
    const s = await setup()
    s.requireCompatibility()
    const failedCommit = vi
      .spyOn(SqliteFinalizeJournalRepository.prototype, 'commitTerminal')
      .mockRejectedValue(new Error('database unavailable'))
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    failedCommit.mockRestore()
    const real = s.fs.makeDurable.bind(s.fs)
    vi.spyOn(s.fs, 'makeDurable').mockImplementation(async (file) => {
      await real(file)
      if (file === s.input.targetPath)
        await writeFile(file, 'changed during recovery')
    })
    await expect(s.runtime.commit(s.input)).rejects.toThrow(
      'reserved target changed before commit'
    )
    expect(s.commits()).toBe(0)
    expect(s.row()?.phase).toBe('quarantined')
    expect(await readFile(s.input.targetPath, 'utf8')).toBe(
      'changed during recovery'
    )
  })

  it('does not fail a recovered task after its terminal transaction has committed', async () => {
    const s = await setup()
    s.requireCompatibility()
    const failedCommit = vi
      .spyOn(SqliteFinalizeJournalRepository.prototype, 'commitTerminal')
      .mockRejectedValue(new Error('database unavailable'))
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    failedCommit.mockRestore()
    const advance = SqliteFinalizeJournalRepository.prototype.advance
    const failedCleanup = vi
      .spyOn(SqliteFinalizeJournalRepository.prototype, 'advance')
      .mockImplementation(async function (
        this: SqliteFinalizeJournalRepository,
        id,
        phase,
        patch
      ) {
        if (phase === 'cleaned') throw new Error('cleanup unavailable')
        return advance.call(this, id, phase, patch)
      })
    await expect(s.runtime.commit(s.input)).resolves.toMatchObject({
      targetPath: s.input.targetPath,
      cleanupPending: true,
    })
    expect(s.row()?.phase).toBe('db_committed')
    expect(s.commits()).toBe(1)
    failedCleanup.mockRestore()
    await s.runtime.recoverAll()
    expect(s.row()?.phase).toBe('cleaned')
    expect(s.commits()).toBe(1)
    expect(await readFile(s.input.targetPath, 'utf8')).toBe('complete download')
  })
  it.runIf(Boolean(image))(
    'resumes the owned reservation after an exFAT remount',
    async () => {
      const s = await setup()
      s.requireCompatibility()
      vi.spyOn(s.adapter, 'renameOpenedReserved').mockRejectedValue(
        new Error('stopped before rename')
      )
      await expect(s.runtime.commit(s.input)).rejects.toThrow()
      const volumeId = await s.fs.reservedVolumeIdentity(s.root)
      await s.adapter.dispose()
      execFileSync('hdiutil', ['detach', volume!], diskImageCommandOptions)
      execFileSync(
        'hdiutil',
        ['attach', image!, '-mountpoint', volume!, '-nobrowse'],
        diskImageCommandOptions
      )
      await s.restart()
      expect(await s.connection.fs.reservedVolumeIdentity(s.root)).toBe(
        volumeId
      )
      await s.connection.runtime.recoverAll()
      expect(s.row()?.phase).toBe('prepared')
      await s.recoverViaTaskService()
      expect(s.row()?.phase).toBe('cleaned')
      expect(await readFile(s.input.targetPath, 'utf8')).toBe(
        'complete download'
      )
      expect(existsSync(s.input.sourcePath)).toBe(false)
    },
    60_000
  )

  it.runIf(Boolean(image))(
    'waits for an offline volume and completes after reconnection',
    async () => {
      const s = await setup()
      s.requireCompatibility()
      vi.spyOn(s.adapter, 'renameOpenedReserved').mockRejectedValue(
        new Error('stopped before rename')
      )
      await expect(s.runtime.commit(s.input)).rejects.toThrow()
      await s.adapter.dispose()
      execFileSync('hdiutil', ['detach', volume!], diskImageCommandOptions)
      try {
        await s.restart()
        await s.connection.runtime.recoverAll()
        expect(s.row()?.phase).toBe('prepared')
        await expect(s.connection.runtime.commit(s.input)).rejects.toThrow()
        expect(s.row()?.phase).toBe('prepared')
      } finally {
        execFileSync(
          'hdiutil',
          ['attach', image!, '-mountpoint', volume!, '-nobrowse'],
          diskImageCommandOptions
        )
      }
      await s.recoverViaTaskService()
      expect(s.row()?.phase).toBe('cleaned')
      expect(await readFile(s.input.targetPath, 'utf8')).toBe(
        'complete download'
      )
    },
    60_000
  )

  it('rejects a changed marker even when its size is unchanged', async () => {
    const s = await setup()
    s.requireCompatibility()
    vi.spyOn(s.adapter, 'renameOpenedReserved').mockRejectedValue(
      new Error('stopped before rename')
    )
    await expect(s.runtime.commit(s.input)).rejects.toThrow()
    const foreign = reservationMarker('f'.repeat(64))
    await writeFile(s.input.targetPath, foreign)
    await s.restart()
    await s.connection.runtime.recoverAll()
    expect(s.row()?.phase).toBe('quarantined')
    expect(await readFile(s.input.targetPath)).toEqual(foreign)
    expect(await readFile(s.input.sourcePath, 'utf8')).toBe('complete download')
  })

  it.each([
    'reservation-created',
    'target-installed',
    'before-terminal-commit',
  ])(
    'recovers after SIGKILL at %s without running compensation',
    async (cut) => {
      const s = await setup()
      await s.adapter.dispose()
      s.db.close()
      const childPath = path.join(s.local, 'crash-child.cjs')
      await build({
        entryPoints: ['src/test-utils/finalize-crash-child.ts'],
        outfile: childPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        banner: {
          js: `require = require('node:module').createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});`,
        },
      })
      const child = spawn(
        process.execPath,
        [childPath, s.dbPath, binary, cut, JSON.stringify(s.input)],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`crash child timed out: ${stderr}`)),
            15_000
          )
          let output = ''
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            reject(new Error(`crash child exited ${code}: ${stderr}`))
          })
          child.stdout.on('data', (chunk) => {
            output += chunk
            if (output.includes('FINALIZE_CRASH_CUT')) {
              clearTimeout(timer)
              resolve()
            }
          })
        })
        const killed = new Promise<string | null>((resolve) =>
          child.once('close', (_code, signal) => resolve(signal))
        )
        child.kill('SIGKILL')
        expect(await killed).toBe('SIGKILL')
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
      await s.restart()
      await s.connection.runtime.recoverAll()
      expect(s.row()?.phase).not.toBe('quarantined')
      await s.recoverViaTaskService()
      expect(s.row()?.phase).toBe('cleaned')
      expect(await readFile(s.input.targetPath, 'utf8')).toBe(
        'complete download'
      )
      expect(existsSync(s.input.sourcePath)).toBe(false)
      expect(s.commits()).toBe(1)
    },
    30_000
  )
})
