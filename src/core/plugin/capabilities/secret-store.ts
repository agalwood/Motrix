// Secret store abstraction — encrypt/decrypt opaque tokens for plugin secret fields.
//
// Two implementations exist:
//   - LibsodiumSecretStore (src/core/plugin/secret-store-libsodium.ts):
//     used by BOTH shells. libsodium symmetric encryption with a seed from
//     MOTRIX_SECRETS_SEED env var or <userDataDir>/secrets.lockbox file.
//     Tokens prefixed "box:". (The Electron shell formerly used a
//     keychain-backed SafeStorageSecretStore; it was deprecated pre-launch to
//     stop the macOS "Safe Storage" keychain prompt.)
//   - FailingSecretStore (this file):
//     sentinel impl for "no secrets configured" — available() === false,
//     any crypto call throws SecretStoreError.
//
// Used by:
//   - config.decryptSecret (Task 13 config capability)
//   - Task 18 factory to inject the correct impl per runtime
//   - Task 22 IPC handler when persisting secret config fields

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class SecretStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SecretStoreError'
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SecretStore {
  /**
   * Encrypts plaintext and returns an opaque token ("safe:..." or "box:...").
   * The token is safe to persist to disk or appSettings JSON.
   */
  encrypt(plaintext: string): Promise<string>

  /**
   * Decrypts an opaque token previously produced by encrypt().
   * Rejects if the token format is invalid or decryption fails.
   */
  decrypt(token: string): Promise<string>

  /**
   * Returns true if the store is functional in this runtime.
   * When false, encrypt/decrypt will always reject.
   */
  available(): boolean
}

// ---------------------------------------------------------------------------
// FailingSecretStore — sentinel for "no secrets configured"
// ---------------------------------------------------------------------------

/**
 * Used by tests and by the server impl when no seed is available.
 * available() is always false; encrypt/decrypt always reject.
 */
export class FailingSecretStore implements SecretStore {
  available(): boolean {
    return false
  }

  async encrypt(_plaintext: string): Promise<string> {
    throw new SecretStoreError(
      'plugin.lifecycle.secrets_seed_missing',
      'secret store is unavailable in this runtime'
    )
  }

  async decrypt(_token: string): Promise<string> {
    throw new SecretStoreError(
      'plugin.lifecycle.secrets_seed_missing',
      'secret store is unavailable in this runtime'
    )
  }
}
