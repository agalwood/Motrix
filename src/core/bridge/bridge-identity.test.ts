import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateBridgeIdentity } from './bridge-identity'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

describe('loadOrCreateBridgeIdentity', () => {
  let tmpDir: string
  let tokenFilePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-identity-'))
    tokenFilePath = path.join(tmpDir, 'local-token')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a 43-char base64url token file at 0600 on first call', async () => {
    const identity = await loadOrCreateBridgeIdentity(tokenFilePath)

    expect(identity.localToken).toMatch(TOKEN_PATTERN)
    expect(identity.localToken).toHaveLength(43)
    expect(identity.serverGeneration).toMatch(UUID_PATTERN)

    const onDisk = await fs.readFile(tokenFilePath, 'utf-8')
    expect(onDisk).toBe(identity.localToken)

    if (process.platform !== 'win32') {
      const st = await fs.stat(tokenFilePath)
      expect(st.mode & 0o777).toBe(0o600)
    }
  })

  it('returns the same localToken but a different serverGeneration on the second call', async () => {
    const first = await loadOrCreateBridgeIdentity(tokenFilePath)
    const second = await loadOrCreateBridgeIdentity(tokenFilePath)

    expect(second.localToken).toBe(first.localToken)
    expect(second.serverGeneration).not.toBe(first.serverGeneration)
    expect(second.serverGeneration).toMatch(UUID_PATTERN)
  })

  it('regenerates the token when the file is empty', async () => {
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true })
    await fs.writeFile(tokenFilePath, '', 'utf-8')

    const identity = await loadOrCreateBridgeIdentity(tokenFilePath)

    expect(identity.localToken).toMatch(TOKEN_PATTERN)
  })

  it('regenerates the token when the file is not base64url', async () => {
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true })
    await fs.writeFile(tokenFilePath, 'not-a-valid-token!!!', 'utf-8')

    const identity = await loadOrCreateBridgeIdentity(tokenFilePath)

    expect(identity.localToken).toMatch(TOKEN_PATTERN)
    expect(identity.localToken).not.toBe('not-a-valid-token!!!')
  })

  it('regenerates the token when the file exceeds 128 characters', async () => {
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true })
    await fs.writeFile(tokenFilePath, 'a'.repeat(200), 'utf-8')

    const identity = await loadOrCreateBridgeIdentity(tokenFilePath)

    expect(identity.localToken).toMatch(TOKEN_PATTERN)
    expect(identity.localToken).not.toBe('a'.repeat(200))
  })

  it('re-chmods the file to 0600 even when permissions were loosened', async () => {
    if (process.platform === 'win32') return // POSIX mode bits only
    const first = await loadOrCreateBridgeIdentity(tokenFilePath)
    await fs.chmod(tokenFilePath, 0o644)

    const second = await loadOrCreateBridgeIdentity(tokenFilePath)
    expect(second.localToken).toBe(first.localToken)

    const st = await fs.stat(tokenFilePath)
    expect(st.mode & 0o777).toBe(0o600)
  })
})
