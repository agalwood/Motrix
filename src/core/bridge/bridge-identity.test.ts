import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadOrCreateBridgeIdentity,
  loadOrCreateBridgeInstanceId,
} from './bridge-identity'

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

describe('loadOrCreateBridgeInstanceId', () => {
  let tmpDir: string
  let instanceIdFilePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-instance-id-'))
    instanceIdFilePath = path.join(tmpDir, 'server-instance-id')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates one stable owner-only UUID identity', async () => {
    const first = await loadOrCreateBridgeInstanceId(instanceIdFilePath)
    const second = await loadOrCreateBridgeInstanceId(instanceIdFilePath)

    expect(first).toMatch(UUID_PATTERN)
    expect(second).toBe(first)
    if (process.platform !== 'win32') {
      expect((await fs.stat(instanceIdFilePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('preserves identity on offline backup restore, resets on a fresh directory, and cannot distinguish a byte-identical clone', async () => {
    const sourceDir = path.join(tmpDir, 'source-data')
    const backupDir = path.join(tmpDir, 'offline-backup')
    const cloneDir = path.join(tmpDir, 'unsupported-live-clone')
    const freshDir = path.join(tmpDir, 'fresh-data')
    const identityPath = (directory: string) =>
      path.join(directory, 'bridge', 'server-instance-id')

    const original = await loadOrCreateBridgeInstanceId(identityPath(sourceDir))
    await fs.cp(sourceDir, backupDir, { recursive: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
    await fs.cp(backupDir, sourceDir, { recursive: true })

    await expect(
      loadOrCreateBridgeInstanceId(identityPath(sourceDir))
    ).resolves.toBe(original)
    await expect(
      loadOrCreateBridgeInstanceId(identityPath(freshDir))
    ).resolves.not.toBe(original)

    // A complete byte-identical clone necessarily carries the same transcript
    // identity. This is why active-active clones are documented as forbidden,
    // not advertised as automatically client-detectable.
    await fs.cp(backupDir, cloneDir, { recursive: true })
    await expect(
      loadOrCreateBridgeInstanceId(identityPath(cloneDir))
    ).resolves.toBe(original)
  })

  it('fails closed rather than silently replacing malformed identity state', async () => {
    await fs.writeFile(instanceIdFilePath, 'not-an-instance-id', {
      mode: 0o600,
    })

    await expect(
      loadOrCreateBridgeInstanceId(instanceIdFilePath)
    ).rejects.toThrow('bridge instance identity unavailable')
    await expect(fs.readFile(instanceIdFilePath, 'utf8')).resolves.toBe(
      'not-an-instance-id'
    )
  })

  it('rejects a symbolic link instead of following it', async () => {
    if (process.platform === 'win32') return
    const target = path.join(tmpDir, 'target')
    await fs.writeFile(target, '00000000-0000-4000-8000-000000000000')
    await fs.symlink(target, instanceIdFilePath)

    await expect(
      loadOrCreateBridgeInstanceId(instanceIdFilePath)
    ).rejects.toThrow('bridge instance identity unavailable')
  })
})
