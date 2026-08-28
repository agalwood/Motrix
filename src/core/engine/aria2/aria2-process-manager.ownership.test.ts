import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode } from '@shared/errors'
import { EngineProcessOwnership } from '@shared/types/engine'
import { describe, expect, it, vi } from 'vitest'
import type { Aria2ProcessInspector } from './aria2-process-inspector'
import { Aria2ProcessManager } from './aria2-process-manager'

const EXPECTED = {
  binaryPath: '/opt/Motrix/extra/darwin/arm64/aria2c',
  args: [
    '--rpc-listen-port=16800',
    '--conf-path=/Users/test/Motrix/aria2.conf',
    '--save-session=/Users/test/Motrix/aria2.session',
    '--rpc-secret=private',
  ],
}

function makeInspector(
  commandLine: string,
  executablePath = EXPECTED.binaryPath
) {
  return {
    inspectListeningPort: vi.fn().mockResolvedValue({
      pid: 4321,
      name: 'aria2c',
      executablePath,
      commandLine,
    }),
    isAlive: vi.fn(() => false),
    forceTerminate: vi.fn(),
  } as unknown as Aria2ProcessInspector
}

describe('Aria2ProcessManager ownership safety', () => {
  it('recognizes a legacy Motrix orphan from the bundled binary and markers', async () => {
    const inspector = makeInspector(
      `${EXPECTED.binaryPath} ${EXPECTED.args.join(' ')}`
    )
    const manager = new Aria2ProcessManager({ inspector })

    await expect(manager.inspectPort(16800, EXPECTED)).resolves.toMatchObject({
      pid: 4321,
      ownership: EngineProcessOwnership.VerifiedOrphan,
      safeToTerminate: true,
    })
  })

  it('protects a manually launched aria2 on the Motrix port', async () => {
    const inspector = makeInspector(
      '/usr/local/bin/aria2c --enable-rpc --rpc-listen-port=16800',
      '/usr/local/bin/aria2c'
    )
    const manager = new Aria2ProcessManager({ inspector })

    await expect(manager.inspectPort(16800, EXPECTED)).resolves.toMatchObject({
      ownership: EngineProcessOwnership.ExternalAria2,
      safeToTerminate: false,
    })
  })

  it('does not trust Motrix paths without the private RPC launch secret', async () => {
    const command = [
      EXPECTED.binaryPath,
      '--rpc-listen-port=16800',
      '--conf-path=/Users/test/Motrix/aria2.conf',
      '--save-session=/Users/test/Motrix/aria2.session',
      '--rpc-secret=user-owned',
    ].join(' ')
    const manager = new Aria2ProcessManager({
      inspector: makeInspector(command),
    })

    await expect(manager.inspectPort(16800, EXPECTED)).resolves.toMatchObject({
      ownership: EngineProcessOwnership.ExternalAria2,
      safeToTerminate: false,
    })
  })

  it('verifies a no-token orphan only with a matching ownership record and launch mode', async () => {
    const expected = {
      ...EXPECTED,
      args: EXPECTED.args.filter((arg) => !arg.startsWith('--rpc-secret=')),
    }
    const command = `${expected.binaryPath} ${expected.args.join(' ')}`
    const withoutRecord = new Aria2ProcessManager({
      inspector: makeInspector(command),
    })

    await expect(
      withoutRecord.inspectPort(16800, expected)
    ).resolves.toMatchObject({
      ownership: EngineProcessOwnership.ExternalAria2,
      safeToTerminate: false,
    })

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'motrix-owner-'))
    const ownershipFilePath = path.join(tempDir, 'aria2-owner.json')
    await writeFile(
      ownershipFilePath,
      JSON.stringify({
        version: 1,
        pid: 4321,
        binaryPath: expected.binaryPath,
        rpcPort: 16800,
        argumentMarkers: expected.args.filter(
          (arg) =>
            arg.startsWith('--conf-path=') ||
            arg.startsWith('--save-session=') ||
            arg.startsWith('--sqlite3-db-path=')
        ),
        startedAt: Date.now(),
      }),
      { mode: 0o600 }
    )

    try {
      const withRecord = new Aria2ProcessManager({
        inspector: makeInspector(command),
        ownershipFilePath,
      })
      await expect(
        withRecord.inspectPort(16800, expected)
      ).resolves.toMatchObject({
        ownership: EngineProcessOwnership.VerifiedOrphan,
        safeToTerminate: true,
      })

      const wrongMode = new Aria2ProcessManager({
        inspector: makeInspector(`${command} --rpc-secret=user-owned`),
        ownershipFilePath,
      })
      await expect(
        wrongMode.inspectPort(16800, expected)
      ).resolves.toMatchObject({
        ownership: EngineProcessOwnership.ExternalAria2,
        safeToTerminate: false,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('rechecks ownership immediately before force termination', async () => {
    const inspector = makeInspector(
      '/usr/local/bin/aria2c --enable-rpc --rpc-listen-port=16800',
      '/usr/local/bin/aria2c'
    )
    const manager = new Aria2ProcessManager({ inspector })

    await expect(
      manager.forceTerminateVerified(4321, 16800, EXPECTED)
    ).rejects.toMatchObject({
      code: ErrorCode.EngineProcessOwnershipUnverified,
    })
    expect(inspector.forceTerminate).not.toHaveBeenCalled()
  })

  it('force terminates only a process that still matches the verified pid', async () => {
    const inspector = makeInspector(
      `${EXPECTED.binaryPath} ${EXPECTED.args.join(' ')}`
    )
    const manager = new Aria2ProcessManager({ inspector })

    await manager.forceTerminateVerified(4321, 16800, EXPECTED)

    expect(inspector.forceTerminate).toHaveBeenCalledWith(4321)
  })
})
