import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { imported, sodium } = vi.hoisted(() => ({
  imported: vi.fn(),
  sodium: {
    ready: Promise.resolve(),
    randombytes_buf: vi.fn(() => new Uint8Array(24)),
    crypto_secretbox_easy: vi.fn(() => new Uint8Array([1, 2, 3])),
  },
}))

vi.mock('libsodium-wrappers', () => {
  imported()
  return { default: sodium }
})

import { LibsodiumSecretStore } from './secret-store-libsodium'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
})

it('keeps WASM unloaded for startup, then shares initialization across secret operations', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motrix-lazy-secrets-'))
  directories.push(dir)
  const first = await LibsodiumSecretStore.create({ userDataDir: dir })
  const second = await LibsodiumSecretStore.create({ userDataDir: dir })
  const seeded = await LibsodiumSecretStore.create({
    userDataDir: dir,
    envSeed: 'a'.repeat(64),
  })
  expect(first.available()).toBe(true)
  expect(second.available()).toBe(true)
  expect(seeded.available()).toBe(true)
  expect(readFileSync(path.join(dir, 'secrets.lockbox'))).toHaveLength(32)
  await expect(first.decrypt('invalid')).rejects.toThrow()
  await expect(first.decrypt('box:AA==:AQ==')).rejects.toThrow()
  expect(imported).not.toHaveBeenCalled()

  let ready!: () => void
  sodium.ready = new Promise<void>((resolve) => {
    ready = resolve
  })
  const operations = [first.encrypt('one'), second.encrypt('two')]
  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce())
  expect(sodium.crypto_secretbox_easy).not.toHaveBeenCalled()
  ready()
  await Promise.all(operations)
  expect(imported).toHaveBeenCalledOnce()
  expect(sodium.crypto_secretbox_easy).toHaveBeenCalledTimes(2)
})
