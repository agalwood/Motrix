import { describe, expect, it } from 'vitest'
import { CryptoCapabilityHost } from './crypto'

describe('CryptoCapabilityHost', () => {
  const cap = new CryptoCapabilityHost()

  it('hash returns deterministic digest', async () => {
    const a = await cap.hash('sha256', 'abc')
    expect(a.byteLength).toBe(32)
    // deterministic: same input → same output
    const b = await cap.hash('sha256', 'abc')
    expect(a).toEqual(b)
  })

  it('hash returns Uint8Array not Buffer', async () => {
    const result = await cap.hash('sha256', 'test')
    expect(result).toBeInstanceOf(Uint8Array)
    // Buffer is a subclass of Uint8Array, but we want plain Uint8Array
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype)
  })

  it('hash sha256 of empty string is correct', async () => {
    const result = await cap.hash('sha256', '')
    // known sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hex = Array.from(result)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(hex).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('hash md5 of "abc" matches the known vector', async () => {
    const result = await cap.hash('md5', 'abc')
    expect(result.byteLength).toBe(16)
    const hex = Array.from(result)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    // known md5('abc') = 900150983cd24fb0d6963f7d28e17f72
    expect(hex).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  it('hmac sha256 returns 32 bytes', async () => {
    const key = cap.randomBytes(32)
    const mac = await cap.hmac('sha256', key, 'hello')
    expect(mac.byteLength).toBe(32)
  })

  it('hmac returns Uint8Array not Buffer', async () => {
    const key = cap.randomBytes(16)
    const result = await cap.hmac('sha256', key, 'test')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype)
  })

  it('randomBytes returns n bytes', () => {
    expect(cap.randomBytes(32).byteLength).toBe(32)
  })

  it('randomBytes(1) works', () => {
    expect(cap.randomBytes(1).byteLength).toBe(1)
  })

  it('randomBytes(4096) works at boundary', () => {
    expect(cap.randomBytes(4096).byteLength).toBe(4096)
  })

  it('randomBytes(n>4096) throws', () => {
    expect(() => cap.randomBytes(8192)).toThrow(/max 4096/)
  })

  it('randomBytes(0) throws', () => {
    expect(() => cap.randomBytes(0)).toThrow()
  })

  it('randomBytes returns Uint8Array not Buffer', () => {
    const result = cap.randomBytes(16)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype)
  })

  it('aes gcm round trip', async () => {
    const key = cap.randomBytes(32)
    const iv = cap.randomBytes(12)
    const data = new TextEncoder().encode('hello')
    const ct = await cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    const pt = await cap.aes({ mode: 'gcm', op: 'decrypt', key, iv, data: ct })
    expect(new TextDecoder().decode(pt)).toBe('hello')
  })

  it('aes gcm ciphertext is longer than plaintext (tag appended)', async () => {
    const key = cap.randomBytes(32)
    const iv = cap.randomBytes(12)
    const data = new TextEncoder().encode('hello')
    const ct = await cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    // 5 bytes plaintext + 16 bytes GCM auth tag
    expect(ct.byteLength).toBe(data.byteLength + 16)
  })

  it('aes cbc round trip aes-128', async () => {
    const key = cap.randomBytes(16)
    const iv = cap.randomBytes(16)
    const data = new TextEncoder().encode('hello world 1234')
    const ct = await cap.aes({ mode: 'cbc', op: 'encrypt', key, iv, data })
    const pt = await cap.aes({ mode: 'cbc', op: 'decrypt', key, iv, data: ct })
    expect(new TextDecoder().decode(pt)).toBe('hello world 1234')
  })

  it('aes gcm aes-128 round trip', async () => {
    const key = cap.randomBytes(16)
    const iv = cap.randomBytes(12)
    const data = new TextEncoder().encode('motrix')
    const ct = await cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    const pt = await cap.aes({ mode: 'gcm', op: 'decrypt', key, iv, data: ct })
    expect(new TextDecoder().decode(pt)).toBe('motrix')
  })

  it('aes throws on invalid key length', async () => {
    const key = cap.randomBytes(10)
    const iv = cap.randomBytes(12)
    const data = new TextEncoder().encode('x')
    await expect(
      cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    ).rejects.toThrow()
  })

  it('aes gcm throws on wrong iv length', async () => {
    const key = cap.randomBytes(32)
    const iv = cap.randomBytes(16) // should be 12 for GCM
    const data = new TextEncoder().encode('x')
    await expect(
      cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    ).rejects.toThrow()
  })

  it('aes cbc throws on wrong iv length', async () => {
    const key = cap.randomBytes(32)
    const iv = cap.randomBytes(12) // should be 16 for CBC
    const data = new TextEncoder().encode('x')
    await expect(
      cap.aes({ mode: 'cbc', op: 'encrypt', key, iv, data })
    ).rejects.toThrow()
  })

  it('aes returns Uint8Array not Buffer', async () => {
    const key = cap.randomBytes(32)
    const iv = cap.randomBytes(12)
    const data = new TextEncoder().encode('test')
    const result = await cap.aes({ mode: 'gcm', op: 'encrypt', key, iv, data })
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype)
  })
})
