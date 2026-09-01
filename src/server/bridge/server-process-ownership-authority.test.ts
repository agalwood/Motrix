import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { establishServerProcessOwnershipAuthority } from './server-process-ownership-authority'

const roots: string[] = []

async function temporaryDataDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motrix-server-owner-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true }))
  )
})

describe('server process ownership authority', () => {
  it('pins the data directory to an already-owned control-plane port', async () => {
    const userDataDir = await temporaryDataDir()
    let listening = true
    const first = await establishServerProcessOwnershipAuthority({
      userDataDir,
      port: 8080,
      assertControlPlaneOwnership: () => listening,
    })

    expect(first.ownershipEpoch).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await expect(first.assertExclusiveProcessOwnership()).resolves.toBe(true)

    const restarted = await establishServerProcessOwnershipAuthority({
      userDataDir,
      port: 8080,
      assertControlPlaneOwnership: () => true,
    })
    await expect(restarted.assertExclusiveProcessOwnership()).resolves.toBe(
      true
    )

    listening = false
    await expect(first.assertExclusiveProcessOwnership()).resolves.toBe(false)
  })

  it('rejects a different port for the same data directory', async () => {
    const userDataDir = await temporaryDataDir()
    await establishServerProcessOwnershipAuthority({
      userDataDir,
      port: 8080,
      assertControlPlaneOwnership: () => true,
    })

    await expect(
      establishServerProcessOwnershipAuthority({
        userDataDir,
        port: 8081,
        assertControlPlaneOwnership: () => true,
      })
    ).rejects.toThrow('server bridge process ownership unavailable')
  })

  it('requires the control-plane listener before creating the binding', async () => {
    const userDataDir = await temporaryDataDir()
    await expect(
      establishServerProcessOwnershipAuthority({
        userDataDir,
        port: 8080,
        assertControlPlaneOwnership: () => false,
      })
    ).rejects.toThrow('server bridge process ownership unavailable')

    await expect(
      fs.stat(path.join(userDataDir, '.motrix-server-bridge-owner.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the durable binding is replaced after startup', async () => {
    const userDataDir = await temporaryDataDir()
    const authority = await establishServerProcessOwnershipAuthority({
      userDataDir,
      port: 8080,
      assertControlPlaneOwnership: () => true,
    })
    const bindingPath = path.join(
      userDataDir,
      '.motrix-server-bridge-owner.json'
    )
    await fs.unlink(bindingPath)
    await fs.writeFile(bindingPath, '{}\n', { mode: 0o600 })

    await expect(authority.assertExclusiveProcessOwnership()).resolves.toBe(
      false
    )
  })

  it('rejects a symbolic-link binding without following it', async () => {
    if (process.platform === 'win32') return
    const userDataDir = await temporaryDataDir()
    const target = path.join(userDataDir, 'target.json')
    await fs.writeFile(target, '{}\n', { mode: 0o600 })
    await fs.symlink(
      target,
      path.join(userDataDir, '.motrix-server-bridge-owner.json')
    )

    await expect(
      establishServerProcessOwnershipAuthority({
        userDataDir,
        port: 8080,
        assertControlPlaneOwnership: () => true,
      })
    ).rejects.toThrow('server bridge process ownership unavailable')
  })
})
