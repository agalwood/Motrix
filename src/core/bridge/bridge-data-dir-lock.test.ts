import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireBridgeDataDirLock,
  BRIDGE_DATA_DIR_LOCK_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE,
  BRIDGE_DATA_DIR_LOCK_UNAVAILABLE,
  type BridgeDataDirLockAcquireOptions,
} from './bridge-data-dir-lock'

interface LockWorker {
  readonly child: ChildProcessWithoutNullStreams
  readonly nextLine: () => Promise<string>
  readonly send: (command: string) => void
}

const workers = new Set<ChildProcessWithoutNullStreams>()
const closedWorkers = new WeakSet<ChildProcessWithoutNullStreams>()
const TEST_OWNERSHIP_EPOCH = 'E'.repeat(43)

describe('bridge data-directory lock', () => {
  let directory: string
  let lockPath: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motrix-bridge-lock-'))
    lockPath = path.join(directory, BRIDGE_DATA_DIR_LOCK_FILE_NAME)
  })

  afterEach(async () => {
    const activeWorkers = [...workers]
    for (const child of activeWorkers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
    await Promise.all(activeWorkers.map((child) => waitForExit(child)))
    workers.clear()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('creates one bounded 0600 lock and returns an idempotent nominal handle', async () => {
    const handle = await acquireBridgeDataDirLock(directory)
    const raw = await fs.readFile(lockPath)
    const document = JSON.parse(raw.toString('utf-8')) as Record<
      string,
      unknown
    >

    expect(raw.byteLength).toBeGreaterThan(0)
    expect(raw.byteLength).toBeLessThanOrEqual(256)
    expect(Object.keys(document).sort()).toEqual([
      'ownerNonce',
      'ownershipEpoch',
      'version',
    ])
    expect(document.version).toBe(1)
    expect(document.ownerNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(document.ownershipEpoch).toBeNull()
    if (process.platform !== 'win32') {
      expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600)
    }

    await expectFixedFailure(acquireBridgeDataDirLock(directory), directory)
    await Promise.all([handle.release(), handle.release(), handle.release()])
    await handle.release()
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const replacement = await acquireBridgeDataDirLock(directory)
    await replacement.release()
  })

  it('does not let authorized recovery steal a live in-process claim', async () => {
    const handle = await acquireBridgeDataDirLock(directory)
    const assertExclusiveProcessOwnership = vi.fn(() => true)

    await expectFixedFailure(
      acquireBridgeDataDirLock(directory, {
        recoverExisting: {
          ownershipEpoch: TEST_OWNERSHIP_EPOCH,
          assertExclusiveProcessOwnership,
        },
      }),
      directory
    )
    expect(assertExclusiveProcessOwnership).not.toHaveBeenCalled()
    await handle.release()
  })

  it.runIf(process.platform !== 'win32')(
    'commits release once unlink succeeds even if the directory sync fails',
    async () => {
      const handle = await acquireBridgeDataDirLock(directory)
      const probe = await fs.open(directory, 'r')
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync(): Promise<void>
      }
      await probe.close()
      const syncSpy = vi
        .spyOn(fileHandlePrototype, 'sync')
        .mockRejectedValue(new Error('synthetic directory sync failure'))

      try {
        await handle.release()
      } finally {
        syncSpy.mockRestore()
      }
      await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const next = await acquireBridgeDataDirLock(directory)
      await next.release()
    }
  )

  it('shares the live claim across duplicate ESM module instances', async () => {
    const worker = spawnLockWorker(directory, 'duplicate-module')
    await expect(worker.nextLine()).resolves.toBe('ready')
    worker.send('go')
    await expect(worker.nextLine()).resolves.toBe(
      `duplicate-protected:0:${BRIDGE_DATA_DIR_LOCK_UNAVAILABLE}`
    )
    await waitForExit(worker.child)
  })

  it.runIf(process.platform !== 'win32')(
    'canonicalizes directory aliases before applying the module claim',
    async () => {
      const alias = path.join(directory, 'same-directory-alias')
      await fs.symlink(directory, alias, 'dir')
      const handle = await acquireBridgeDataDirLock(directory)

      await expectFixedFailure(acquireBridgeDataDirLock(alias), directory)
      await handle.release()
    }
  )

  it('does not let an old released handle remove its successor', async () => {
    const old = await acquireBridgeDataDirLock(directory)
    await old.release()
    const current = await acquireBridgeDataDirLock(directory)

    await old.release()
    await expectFixedFailure(acquireBridgeDataDirLock(directory), directory)
    await current.release()
  })

  it.runIf(process.platform !== 'win32')(
    'refuses to release a replaced path even when its content looks valid',
    async () => {
      const handle = await acquireBridgeDataDirLock(directory)
      const displacedPath = `${lockPath}.displaced`
      await fs.rename(lockPath, displacedPath)
      const forged = JSON.stringify({
        version: 1,
        ownerNonce: 'A'.repeat(43),
        ownershipEpoch: null,
      })
      await fs.writeFile(lockPath, forged, { mode: 0o600 })

      await expectFixedFailure(handle.release(), directory)
      await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe(forged)
      expect((await fs.lstat(displacedPath)).isFile()).toBe(true)

      await fs.unlink(lockPath)
      await fs.rename(displacedPath, lockPath)
      await handle.release()
    }
  )

  it('fails with one redacted error while another process owns the lock', async () => {
    const worker = spawnLockWorker(directory, 'hold')
    await expect(worker.nextLine()).resolves.toBe('ready')
    worker.send('go')
    await expect(worker.nextLine()).resolves.toBe('acquired')

    await expectFixedFailure(acquireBridgeDataDirLock(directory), directory)
    worker.send('release')
    await expect(worker.nextLine()).resolves.toBe('released')
    await waitForExit(worker.child)
  })

  it('keeps crash residue fail-closed by default and recovers only with external authority', async () => {
    const worker = spawnLockWorker(directory, 'crash')
    await expect(worker.nextLine()).resolves.toBe('ready')
    worker.send('go')
    await expect(worker.nextLine()).resolves.toBe('acquired')
    await waitForExit(worker.child)
    const residue = await fs.readFile(lockPath)

    await expectFixedFailure(acquireBridgeDataDirLock(directory), directory)
    await expectFixedFailure(
      acquireBridgeDataDirLock(directory, {
        recoverExisting: {
          ownershipEpoch: TEST_OWNERSHIP_EPOCH,
          assertExclusiveProcessOwnership: () => false,
        },
      }),
      directory
    )
    await expectFixedFailure(
      acquireBridgeDataDirLock(directory, {
        recoverExisting: {
          ownershipEpoch: TEST_OWNERSHIP_EPOCH,
          assertExclusiveProcessOwnership: () => {
            throw new Error('private-process-detail')
          },
        },
      }),
      directory
    )
    expect(await fs.readFile(lockPath)).toEqual(residue)
    const assertExclusiveProcessOwnership = vi.fn(() => true)
    const recovery = acquireBridgeDataDirLock(directory, {
      recoverExisting: {
        ownershipEpoch: TEST_OWNERSHIP_EPOCH,
        assertExclusiveProcessOwnership,
      },
    })

    if (
      BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE ===
      'external-single-instance-authority'
    ) {
      const recovered = await recovery
      expect(assertExclusiveProcessOwnership).toHaveBeenCalledTimes(1)
      expect(await fs.readFile(lockPath)).not.toEqual(residue)
      expect(await fs.readdir(directory)).toEqual([
        BRIDGE_DATA_DIR_LOCK_FILE_NAME,
      ])
      await recovered.release()
    } else {
      await expectFixedFailure(recovery, directory)
      expect(assertExclusiveProcessOwnership).not.toHaveBeenCalled()
      expect(await fs.readFile(lockPath)).toEqual(residue)
    }
  })

  it.runIf(
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE === 'external-single-instance-authority'
  )('allows only one authorized recovery contender to acquire', async () => {
    const crashed = spawnLockWorker(directory, 'crash')
    await expect(crashed.nextLine()).resolves.toBe('ready')
    crashed.send('go')
    await expect(crashed.nextLine()).resolves.toBe('acquired')
    await waitForExit(crashed.child)

    const first = spawnLockWorker(directory, 'recover')
    const second = spawnLockWorker(directory, 'recover')
    await Promise.all([
      expect(first.nextLine()).resolves.toBe('ready'),
      expect(second.nextLine()).resolves.toBe('ready'),
    ])
    first.send('go')
    second.send('go')
    const outcomes = await Promise.all([first.nextLine(), second.nextLine()])

    expect([...outcomes].sort()).toEqual([
      'acquired',
      `failed:${BRIDGE_DATA_DIR_LOCK_UNAVAILABLE}`,
    ])
    const winner = outcomes[0] === 'acquired' ? first : second
    const loser = winner === first ? second : first

    const delayed = spawnLockWorker(directory, 'recover')
    await expect(delayed.nextLine()).resolves.toBe('ready')
    delayed.send('go')
    await expect(delayed.nextLine()).resolves.toBe(
      `failed:${BRIDGE_DATA_DIR_LOCK_UNAVAILABLE}`
    )
    winner.send('release')
    await expect(winner.nextLine()).resolves.toBe('released')
    await Promise.all([
      waitForExit(winner.child),
      waitForExit(loser.child),
      waitForExit(delayed.child),
    ])
  })

  it.runIf(
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE === 'external-single-instance-authority'
  )(
    'resumes every durable interrupted-recovery shape in a new ownership epoch',
    async () => {
      const guardPath = path.join(directory, '.motrix-bridge.lock.recovery')
      const recoveryNonce = 'Q'.repeat(43)
      const quarantinePath = `${lockPath}.stale-${recoveryNonce}`
      const oldLock = {
        version: 1,
        ownerNonce: 'L'.repeat(43),
        ownershipEpoch: null,
      }
      const replacementLock = {
        version: 1,
        ownerNonce: 'N'.repeat(43),
        ownershipEpoch: 'O'.repeat(43),
      }
      const guard = {
        version: 1,
        recoveryNonce,
        ownershipEpoch: 'O'.repeat(43),
      }
      const stages: Array<() => Promise<void>> = [
        async () => {
          await writePrivateJson(lockPath, oldLock)
        },
        async () => {
          await writePrivateJson(lockPath, oldLock)
          await fs.link(lockPath, quarantinePath)
        },
        async () => {
          await writePrivateJson(lockPath, oldLock)
          await fs.link(lockPath, quarantinePath)
          await fs.unlink(lockPath)
        },
        async () => {
          await writePrivateJson(quarantinePath, oldLock)
          await writePrivateJson(lockPath, replacementLock)
        },
        async () => {
          await writePrivateJson(lockPath, replacementLock)
        },
        async () => undefined,
      ]

      for (const createStage of stages) {
        await writePrivateJson(guardPath, guard)
        await createStage()

        const recovered = await acquireBridgeDataDirLock(
          directory,
          authorizedRecovery(TEST_OWNERSHIP_EPOCH)
        )
        expect(await fs.readdir(directory)).toEqual([
          BRIDGE_DATA_DIR_LOCK_FILE_NAME,
        ])
        await recovered.release()
        expect(await fs.readdir(directory)).toEqual([])
      }
    }
  )

  it.runIf(
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE === 'external-single-instance-authority'
  )(
    'does not resume a recovery guard from the current ownership epoch',
    async () => {
      const guardPath = path.join(directory, '.motrix-bridge.lock.recovery')
      await writePrivateJson(guardPath, {
        version: 1,
        recoveryNonce: 'Q'.repeat(43),
        ownershipEpoch: TEST_OWNERSHIP_EPOCH,
      })
      await writePrivateJson(lockPath, {
        version: 1,
        ownerNonce: 'L'.repeat(43),
        ownershipEpoch: null,
      })

      await expectFixedFailure(
        acquireBridgeDataDirLock(
          directory,
          authorizedRecovery(TEST_OWNERSHIP_EPOCH)
        ),
        directory
      )
      expect(await fs.readdir(directory)).toEqual([
        BRIDGE_DATA_DIR_LOCK_FILE_NAME,
        '.motrix-bridge.lock.recovery',
      ])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'never follows a forged final symlink during default or authorized acquire',
    async () => {
      const target = path.join(directory, 'sensitive.txt')
      await fs.writeFile(target, 'preserve-me', { mode: 0o600 })
      await fs.symlink(target, lockPath)

      await expectFixedFailure(acquireBridgeDataDirLock(directory), directory)
      await expectFixedFailure(
        acquireBridgeDataDirLock(directory, authorizedRecovery()),
        directory
      )
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('preserve-me')
      expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true)
    }
  )

  it('rejects non-regular, oversized, and malformed recovery candidates', async () => {
    const cases: Array<() => Promise<void>> = [
      async () => fs.mkdir(lockPath),
      async () =>
        fs.writeFile(lockPath, Buffer.alloc(257, 0x61), { mode: 0o600 }),
      async () => fs.writeFile(lockPath, '{"version":1}', { mode: 0o600 }),
    ]
    if (process.platform !== 'win32') {
      cases.push(async () => {
        await fs.writeFile(
          lockPath,
          JSON.stringify({
            version: 1,
            ownerNonce: 'A'.repeat(43),
            ownershipEpoch: null,
          }),
          { mode: 0o600 }
        )
        await fs.chmod(lockPath, 0o644)
      })
    }

    for (const createCandidate of cases) {
      await createCandidate()
      await expectFixedFailure(
        acquireBridgeDataDirLock(directory, authorizedRecovery()),
        directory
      )
      await fs.rm(lockPath, { recursive: true, force: true })
    }
  })

  it('publishes an explicit fail-closed recovery downgrade', () => {
    expect([
      'external-single-instance-authority',
      'unavailable-fail-closed',
    ]).toContain(BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE)
    if (process.platform === 'win32') {
      expect(BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE).toBe('unavailable-fail-closed')
    }
  })
})

function authorizedRecovery(
  ownershipEpoch = TEST_OWNERSHIP_EPOCH
): BridgeDataDirLockAcquireOptions {
  return {
    recoverExisting: {
      ownershipEpoch,
      assertExclusiveProcessOwnership: () => true,
    },
  }
}

async function writePrivateJson(
  filePath: string,
  value: Record<string, unknown>
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 })
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600)
}

async function expectFixedFailure(
  promise: Promise<unknown>,
  sensitivePath: string
): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toBe(BRIDGE_DATA_DIR_LOCK_UNAVAILABLE)
  expect(message).not.toContain(sensitivePath)
  expect(message).not.toContain(process.pid.toString())
}

function spawnLockWorker(
  directory: string,
  mode: 'hold' | 'crash' | 'recover' | 'duplicate-module'
): LockWorker {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'src/core/bridge/bridge-data-dir-lock.ts')
  ).href
  const script = `
    import readline from 'node:readline'
    import {
      acquireBridgeDataDirLock,
      BRIDGE_DATA_DIR_LOCK_UNAVAILABLE,
    } from ${JSON.stringify(moduleUrl)}

    const moduleUrl = ${JSON.stringify(moduleUrl)}
    const directory = process.argv[1]
    const mode = process.argv[2]
    const lines = readline.createInterface({ input: process.stdin })
    let handle = null

    process.stdout.write('ready\\n')
    lines.on('line', async (line) => {
      if (line === 'go') {
        if (mode === 'duplicate-module') {
          const first = await import(moduleUrl + '?instance=first')
          const second = await import(moduleUrl + '?instance=second')
          const firstHandle = await first.acquireBridgeDataDirLock(directory)
          let authorityCalls = 0
          try {
            await second.acquireBridgeDataDirLock(directory, {
              recoverExisting: {
                ownershipEpoch: 'R'.repeat(43),
                assertExclusiveProcessOwnership: () => {
                  authorityCalls += 1
                  return true
                },
              },
            })
            await firstHandle.release()
            process.stdout.write(
              'duplicate-bypassed:' + String(authorityCalls) + '\\n',
              () => process.exit(0)
            )
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : BRIDGE_DATA_DIR_LOCK_UNAVAILABLE
            await firstHandle.release()
            process.stdout.write(
              'duplicate-protected:' +
                String(authorityCalls) +
                ':' +
                message +
                '\\n',
              () => process.exit(0)
            )
          }
          return
        }
        try {
          handle = await acquireBridgeDataDirLock(
            directory,
            mode === 'recover'
              ? {
                recoverExisting: {
                    ownershipEpoch: 'R'.repeat(43),
                    assertExclusiveProcessOwnership: () => true,
                  },
                }
              : undefined
          )
          process.stdout.write('acquired\\n', () => {
            if (mode === 'crash') process.exit(0)
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : BRIDGE_DATA_DIR_LOCK_UNAVAILABLE
          process.stdout.write('failed:' + message + '\\n', () => process.exit(0))
        }
      }
      if (line === 'release' && handle !== null) {
        try {
          await handle.release()
          process.stdout.write('released\\n', () => process.exit(0))
        } catch {
          process.stdout.write(
            'failed:' + BRIDGE_DATA_DIR_LOCK_UNAVAILABLE + '\\n',
            () => process.exit(0)
          )
        }
      }
    })
  `
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      directory,
      mode,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  workers.add(child)

  let buffer = ''
  let stderr = ''
  const queued: string[] = []
  const waiters: Array<{
    readonly resolve: (line: string) => void
    readonly reject: (error: Error) => void
  }> = []
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const waiter = waiters.shift()
      if (waiter === undefined) queued.push(line)
      else waiter.resolve(line)
      newline = buffer.indexOf('\n')
    }
  })
  child.once('close', (code, signal) => {
    closedWorkers.add(child)
    workers.delete(child)
    for (const waiter of waiters.splice(0)) {
      waiter.reject(
        new Error(
          `lock worker exited before output (${String(code)}, ${String(signal)}): ${stderr}`
        )
      )
    }
  })

  return {
    child,
    nextLine: async () => {
      const next = queued.shift()
      if (next !== undefined) return next
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`lock worker output timed out: ${stderr}`))
        }, 10_000)
        waiters.push({
          resolve: (line) => {
            clearTimeout(timeout)
            resolve(line)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
        })
      })
    },
    send: (command) => child.stdin.write(`${command}\n`),
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  if (closedWorkers.has(child)) return
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}
