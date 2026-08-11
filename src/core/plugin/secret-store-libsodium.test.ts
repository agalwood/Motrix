// Tests for LibsodiumSecretStore.
//
// Uses a deterministic 64-hex env seed for most tests.
// Lockbox tests use os.tmpdir() + a unique subfolder per test.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FailingSecretStore } from '@core/plugin/capabilities/secret-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LibsodiumSecretStore } from './secret-store-libsodium'

// Deterministic env seed for tests (64 hex chars = 32 bytes).
const TEST_SEED = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `motrix-secret-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LibsodiumSecretStore', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Test 1: returns FailingSecretStore when no env seed and userDataDir is
  // a non-existent read-only path (simulate unavailable).
  it('create returns FailingSecretStore when no seed and dir is not writable', async () => {
    // Use a deeply non-writable path that cannot be created.
    const store = await LibsodiumSecretStore.create({
      userDataDir: '/proc/non-existent-dir-that-cannot-be-created',
      envSeed: undefined,
    })
    expect(store).toBeInstanceOf(FailingSecretStore)
    expect(store.available()).toBe(false)
  })

  it('does not read a secret seed from the ambient process environment', async () => {
    vi.stubEnv('MOTRIX_SECRETS_SEED', TEST_SEED)
    const store = await LibsodiumSecretStore.create({
      userDataDir: '/proc/non-existent-dir-that-cannot-be-created',
      envSeed: undefined,
    })
    expect(store).toBeInstanceOf(FailingSecretStore)
  })

  // Test 2: create with valid env seed returns LibsodiumSecretStore.
  it('create with env seed returns LibsodiumSecretStore', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)
    expect(store.available()).toBe(true)
  })

  // Test 3: encrypt then decrypt round-trip returns the original plaintext.
  it('encrypt then decrypt round-trip returns plaintext', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)

    const plaintext = 'super-secret-api-key-12345'
    const token = await store.encrypt(plaintext)
    const recovered = await store.decrypt(token)
    expect(recovered).toBe(plaintext)
  })

  // Test 4: decrypt of malformed "box:" token rejects.
  it('decrypt of malformed box: token rejects', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)

    // Missing second segment
    await expect(store.decrypt('box:onlyone')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_invalid_token',
    })

    // Wrong prefix
    await expect(store.decrypt('safe:abc')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_invalid_token',
    })

    // Empty token
    await expect(store.decrypt('')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_invalid_token',
    })
  })

  // Test 5: tokens always start with "box:" and have two base64 segments.
  it('encrypted tokens start with "box:" and have two base64 segments', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)

    const token = await store.encrypt('hello')
    expect(token.startsWith('box:')).toBe(true)

    const rest = token.slice('box:'.length)
    const parts = rest.split(':')
    expect(parts).toHaveLength(2)
    // Both segments should be non-empty base64
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
  })

  // Test 6: encrypt twice produces different ciphertexts (different nonces).
  it('encrypt twice produces different ciphertexts', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)

    const token1 = await store.encrypt('same-plaintext')
    const token2 = await store.encrypt('same-plaintext')
    expect(token1).not.toBe(token2)
  })

  // Test 7a: when userDataDir is writable and no env seed, create writes the lockbox.
  it('lockbox: writes lockbox file when dir is writable and no seed', async () => {
    const store = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: undefined,
    })
    expect(store).toBeInstanceOf(LibsodiumSecretStore)
    const lockboxPath = path.join(tmpDir, 'secrets.lockbox')
    expect(existsSync(lockboxPath)).toBe(true)
    const bytes = readFileSync(lockboxPath)
    expect(bytes.byteLength).toBe(32)
  })

  // Test 7b: subsequent create calls with same dir read back the same lockbox key.
  it('lockbox: subsequent create uses same key (stable encrypt/decrypt across instances)', async () => {
    // First create writes the lockbox.
    const store1 = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: undefined,
    })
    expect(store1).toBeInstanceOf(LibsodiumSecretStore)

    const plaintext = 'stable-key-test'
    const token = await store1.encrypt(plaintext)

    // Second create reads the lockbox — must be able to decrypt store1's token.
    const store2 = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: undefined,
    })
    expect(store2).toBeInstanceOf(LibsodiumSecretStore)
    const recovered = await store2.decrypt(token)
    expect(recovered).toBe(plaintext)
  })

  // Test 8: decrypt with wrong key (different seed) rejects.
  it('decrypt with mismatched key rejects', async () => {
    const store1 = await LibsodiumSecretStore.create({
      userDataDir: tmpDir,
      envSeed: TEST_SEED,
    })
    expect(store1).toBeInstanceOf(LibsodiumSecretStore)

    const token = await store1.encrypt('secret')

    const tmpDir2 = makeTmpDir()
    try {
      const store2 = await LibsodiumSecretStore.create({
        userDataDir: tmpDir2,
        envSeed: 'b'.repeat(64),
      })
      expect(store2).toBeInstanceOf(LibsodiumSecretStore)

      await expect(store2.decrypt(token)).rejects.toMatchObject({
        code: 'plugin.lifecycle.secrets_decrypt_failed',
      })
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true })
    }
  })
})
