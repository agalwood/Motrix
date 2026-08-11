// libsodium-backed SecretStore implementation shared by both shells.
//
// File-backed key, no OS keychain: avoids the macOS "Safe Storage" keychain
// prompt that the Electron shell used to trigger via safeStorage. The Electron
// shell formerly carried a keychain-backed SafeStorageSecretStore; it was
// deprecated pre-launch (the original extension-pair-token use case moved to
// plain JSON), so both the Electron and Node/server runtimes now use this one
// engine-agnostic implementation.
//
// Token format: "box:<base64(nonce 24 bytes)>:<base64(crypto_secretbox_easy ct)>"
//
// Key source priority (resolved by static factory LibsodiumSecretStore.create):
//   1. shell-provided envSeed option — 64 hex chars (32 bytes)
//   2. <userDataDir>/secrets.lockbox file — 32 raw bytes
//   3. If userDataDir is writable, generate and write a new lockbox (chmod 0600)
//   4. Otherwise return FailingSecretStore (no encrypt/decrypt possible)
//
// Must use async factory pattern because sodium.ready must be awaited before
// any crypto call. Never construct directly.
//
// Used by:
//   - Task 18 factory: injected as the SecretStore impl in both runtimes
//   - Task 22 IPC handler: encrypts/decrypts secret config fields

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  FailingSecretStore,
  type SecretStore,
  SecretStoreError,
} from '@core/plugin/capabilities/secret-store'
import sodium from 'libsodium-wrappers'

export type { FailingSecretStore }

const PREFIX = 'box:'
const NONCE_BYTES = 24
const KEY_BYTES = 32
const LOCKBOX_FILE = 'secrets.lockbox'

export interface LibsodiumSecretStoreOptions {
  userDataDir: string
  /** Shell-provided secret seed (64 hex chars); omitted to use the lockbox. */
  envSeed?: string
}

export class LibsodiumSecretStore implements SecretStore {
  private constructor(private readonly key: Uint8Array) {}

  /**
   * Async factory — must be used instead of new.
   * Awaits sodium.ready and resolves a key via the priority chain.
   * Returns FailingSecretStore if no key source is available.
   */
  static async create(
    opts: LibsodiumSecretStoreOptions
  ): Promise<LibsodiumSecretStore | FailingSecretStore> {
    await sodium.ready

    const rawSeed = opts.envSeed

    // Priority 1: env seed (64 hex chars = 32 bytes)
    if (rawSeed) {
      if (rawSeed.length === 64 && /^[0-9a-fA-F]+$/.test(rawSeed)) {
        const key = new Uint8Array(Buffer.from(rawSeed, 'hex'))
        return new LibsodiumSecretStore(key)
      }
    }

    // Priority 2 + 3: lockbox file
    const lockboxPath = path.join(opts.userDataDir, LOCKBOX_FILE)

    if (existsSync(lockboxPath)) {
      const buf = readFileSync(lockboxPath)
      if (buf.byteLength === KEY_BYTES) {
        return new LibsodiumSecretStore(new Uint8Array(buf))
      }
    }

    // Priority 3: create new lockbox if userDataDir is writable
    try {
      const key = sodium.randombytes_buf(KEY_BYTES)
      // Create the lockbox atomically at 0o600 so the symmetric key is never
      // briefly group/world-readable in the window between create and chmod.
      // `wx` = exclusive create (O_CREAT|O_EXCL); `mode` is applied on creation
      // and umask can only clear bits, never widen beyond 0o600.
      writeFileSync(lockboxPath, Buffer.from(key), { flag: 'wx', mode: 0o600 })
      return new LibsodiumSecretStore(new Uint8Array(key))
    } catch {
      // userDataDir not writable or lockbox exists but is wrong size
      return new FailingSecretStore()
    }
  }

  available(): boolean {
    return true
  }

  async encrypt(plaintext: string): Promise<string> {
    await sodium.ready
    const nonce = sodium.randombytes_buf(NONCE_BYTES)
    const ct = sodium.crypto_secretbox_easy(plaintext, nonce, this.key)
    const nonceb64 = Buffer.from(nonce).toString('base64')
    const ctb64 = Buffer.from(ct).toString('base64')
    return `${PREFIX}${nonceb64}:${ctb64}`
  }

  async decrypt(token: string): Promise<string> {
    if (!token.startsWith(PREFIX)) {
      throw new SecretStoreError(
        'plugin.lifecycle.secrets_invalid_token',
        `secret token has invalid format: expected prefix "${PREFIX}"`
      )
    }

    const rest = token.slice(PREFIX.length)
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) {
      throw new SecretStoreError(
        'plugin.lifecycle.secrets_invalid_token',
        'secret token has invalid format: missing nonce/ciphertext separator'
      )
    }

    const nonceb64 = rest.slice(0, colonIdx)
    const ctb64 = rest.slice(colonIdx + 1)

    if (!nonceb64 || !ctb64) {
      throw new SecretStoreError(
        'plugin.lifecycle.secrets_invalid_token',
        'secret token has invalid format: empty nonce or ciphertext segment'
      )
    }

    await sodium.ready
    const nonce = new Uint8Array(Buffer.from(nonceb64, 'base64'))
    const ct = new Uint8Array(Buffer.from(ctb64, 'base64'))

    if (nonce.byteLength !== NONCE_BYTES) {
      throw new SecretStoreError(
        'plugin.lifecycle.secrets_invalid_token',
        `secret token nonce must be ${NONCE_BYTES} bytes`
      )
    }

    let plainBytes: Uint8Array
    try {
      plainBytes = sodium.crypto_secretbox_open_easy(ct, nonce, this.key)
    } catch {
      throw new SecretStoreError(
        'plugin.lifecycle.secrets_decrypt_failed',
        'libsodium decryption failed: ciphertext may be tampered or key mismatch'
      )
    }

    return sodium.to_string(plainBytes)
  }
}
