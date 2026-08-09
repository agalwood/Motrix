// Tests for FailingSecretStore and SecretStoreError shape.
// These are pure core types — no Electron, no libsodium.

import { describe, expect, it } from 'vitest'
import { FailingSecretStore, SecretStoreError } from './secret-store'

describe('SecretStoreError', () => {
  it('has a code property', () => {
    const err = new SecretStoreError(
      'plugin.lifecycle.secrets_seed_missing',
      'msg'
    )
    expect(err.code).toBe('plugin.lifecycle.secrets_seed_missing')
    expect(err.message).toBe('msg')
    expect(err.name).toBe('SecretStoreError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('FailingSecretStore', () => {
  const store = new FailingSecretStore()

  it('available() === false', () => {
    expect(store.available()).toBe(false)
  })

  it('encrypt rejects with plugin.lifecycle.secrets_seed_missing', async () => {
    await expect(store.encrypt('anything')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_seed_missing',
    })
  })

  it('decrypt rejects with plugin.lifecycle.secrets_seed_missing', async () => {
    await expect(store.decrypt('safe:abc')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_seed_missing',
    })
  })

  it('rejected errors are SecretStoreError instances', async () => {
    await expect(store.encrypt('x')).rejects.toBeInstanceOf(SecretStoreError)
  })
})
