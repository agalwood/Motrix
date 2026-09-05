import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_DATA_DIR_LOCK_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_RECOVERY_GUARD_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_UNAVAILABLE,
  type BridgeDataDirLockRecoveryAuthority,
} from '@core/bridge/bridge-data-dir-lock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverDefaultWindowsDesktopBridgeResidue } from './windows-desktop-startup-recovery'

const RESIDUE_NAMES = [
  'endpoint.json',
  'extension-pairings.json.lock',
  BRIDGE_DATA_DIR_LOCK_RECOVERY_GUARD_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_FILE_NAME,
] as const

describe('recoverDefaultWindowsDesktopBridgeResidue', () => {
  let root: string
  let bridgeDirectory: string
  let authority: BridgeDataDirLockRecoveryAuthority
  let ownsProcess: boolean
  let assertExclusiveProcessOwnership: BridgeDataDirLockRecoveryAuthority['assertExclusiveProcessOwnership']

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'motrix-windows-recovery-'))
    bridgeDirectory = join(root, 'bridge')
    await mkdir(bridgeDirectory)
    ownsProcess = true
    assertExclusiveProcessOwnership = vi.fn(() => ownsProcess)
    authority = {
      ownershipEpoch: 'W'.repeat(43),
      assertExclusiveProcessOwnership,
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('removes only startup residue from the default Windows desktop root', async () => {
    for (const fileName of RESIDUE_NAMES) {
      await writeFile(join(bridgeDirectory, fileName), 'residue')
    }
    await writeFile(join(bridgeDirectory, 'local-token'), 'preserved-token')
    await writeFile(join(bridgeDirectory, 'pairing.json'), 'preserved-pairing')

    await recoverDefaultWindowsDesktopBridgeResidue({
      platform: 'win32',
      dataDirectory: bridgeDirectory,
      bridgeDataDirectoryOverride: undefined,
      authority,
    })

    expect(assertExclusiveProcessOwnership).toHaveBeenCalledOnce()
    for (const fileName of RESIDUE_NAMES) {
      await expect(
        lstat(join(bridgeDirectory, fileName))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(
      readFile(join(bridgeDirectory, 'local-token'), 'utf8')
    ).resolves.toBe('preserved-token')
    await expect(
      readFile(join(bridgeDirectory, 'pairing.json'), 'utf8')
    ).resolves.toBe('preserved-pairing')
  })

  it.each([
    ['darwin', false],
    ['linux', false],
    ['win32', true],
  ] as const)(
    'does nothing on platform %s with custom override %s',
    async (platform, usesCustomOverride) => {
      const lockPath = join(bridgeDirectory, BRIDGE_DATA_DIR_LOCK_FILE_NAME)
      await writeFile(lockPath, 'preserved')

      await recoverDefaultWindowsDesktopBridgeResidue({
        platform,
        dataDirectory: bridgeDirectory,
        bridgeDataDirectoryOverride: usesCustomOverride
          ? bridgeDirectory
          : undefined,
        authority,
      })

      expect(assertExclusiveProcessOwnership).not.toHaveBeenCalled()
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('preserved')
    }
  )

  it('keeps residue when Electron no longer owns the app lock', async () => {
    ownsProcess = false
    const lockPath = join(bridgeDirectory, BRIDGE_DATA_DIR_LOCK_FILE_NAME)
    await writeFile(lockPath, 'preserved')

    await expect(
      recoverDefaultWindowsDesktopBridgeResidue({
        platform: 'win32',
        dataDirectory: bridgeDirectory,
        bridgeDataDirectoryOverride: undefined,
        authority,
      })
    ).rejects.toThrow(BRIDGE_DATA_DIR_LOCK_UNAVAILABLE)
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('preserved')
  })

  it.runIf(process.platform !== 'win32')(
    'unlinks a final symlink without touching its target',
    async () => {
      const target = join(root, 'outside-target')
      const endpointPath = join(bridgeDirectory, 'endpoint.json')
      await writeFile(target, 'preserved')
      await symlink(target, endpointPath)

      await recoverDefaultWindowsDesktopBridgeResidue({
        platform: 'win32',
        dataDirectory: bridgeDirectory,
        bridgeDataDirectoryOverride: undefined,
        authority,
      })

      await expect(lstat(endpointPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(target, 'utf8')).resolves.toBe('preserved')
    }
  )

  it('fails closed on an unexpected directory', async () => {
    const endpointPath = join(bridgeDirectory, 'endpoint.json')
    await mkdir(endpointPath)

    await expect(
      recoverDefaultWindowsDesktopBridgeResidue({
        platform: 'win32',
        dataDirectory: bridgeDirectory,
        bridgeDataDirectoryOverride: undefined,
        authority,
      })
    ).rejects.toThrow(BRIDGE_DATA_DIR_LOCK_UNAVAILABLE)
    expect((await lstat(endpointPath)).isDirectory()).toBe(true)
  })
})
