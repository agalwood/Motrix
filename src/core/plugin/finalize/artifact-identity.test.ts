import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ArtifactIdentityCache,
  artifactContentEquals,
  artifactIdentityEquals,
  readArtifactIdentity,
  readRenameFileIdentity,
} from './artifact-identity'
import * as hashing from './hash-opened-file'

describe('artifact identity', () => {
  it('hashes regular files with a held no-follow descriptor', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-identity-'))
    const artifact = path.join(root, 'artifact.bin')
    await writeFile(artifact, 'known bytes')
    const first = await readArtifactIdentity(artifact)
    const second = await readArtifactIdentity(artifact)
    expect(first.kind).toBe('file')
    expect(artifactIdentityEquals(first, second)).toBe(true)
  })

  it('hashes directory shape, empty directories, and file bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-tree-'))
    await mkdir(path.join(root, 'empty'))
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested', 'file'), 'payload')
    const identity = await readArtifactIdentity(root)
    expect(identity).toMatchObject({
      kind: 'directory',
      entryCount: 3,
      totalBytes: 7,
    })
  })

  it('rejects symbolic links instead of following them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-link-'))
    await writeFile(path.join(root, 'outside'), 'secret')
    await mkdir(path.join(root, 'tree'))
    await symlink(path.join(root, 'outside'), path.join(root, 'tree', 'link'))
    await expect(
      readArtifactIdentity(path.join(root, 'tree'))
    ).rejects.toMatchObject({ code: 'artifact_unsafe_path' })
  })

  it('distinguishes exact inode identity from equal copied content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-copy-'))
    const firstPath = path.join(root, 'first')
    const secondPath = path.join(root, 'second')
    await writeFile(firstPath, 'same')
    await writeFile(secondPath, 'same')
    const first = await readArtifactIdentity(firstPath)
    const second = await readArtifactIdentity(secondPath)
    expect(artifactContentEquals(first, second)).toBe(true)
    expect(artifactIdentityEquals(first, second)).toBe(false)
  })

  it('fails the entry bound rather than producing a partial tree identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-limit-'))
    await writeFile(path.join(root, 'one'), '1')
    await writeFile(path.join(root, 'two'), '2')
    await expect(
      readArtifactIdentity(root, { maxEntries: 1 })
    ).rejects.toMatchObject({ code: 'artifact_too_large' })
  })
})

describe('artifact digest reuse', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reuses unchanged file bytes but detects same-size edits inside a directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-cached-tree-'))
    const file = path.join(root, 'file')
    await writeFile(file, 'before')
    const hash = vi.spyOn(hashing, 'hashOpenedFile')
    const options = { cache: new ArtifactIdentityCache() }
    const first = await readArtifactIdentity(root, options)
    expect(await readArtifactIdentity(root, options)).toEqual(first)
    expect(hash).toHaveBeenCalledTimes(1)
    await writeFile(file, 'edited')
    expect(await readArtifactIdentity(root, options)).not.toEqual(first)
    expect(hash).toHaveBeenCalledTimes(2)
  })

  it('hashes large held files in the worker without changing the digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-worker-hash-'))
    const file = path.join(root, 'large')
    const bytes = Buffer.alloc(17 * 1024 * 1024, 0x61)
    await writeFile(file, bytes)
    const identity = await readArtifactIdentity(file)
    expect(identity).toMatchObject({
      kind: 'file',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  })
})

describe('rename-only artifact identity', () => {
  afterEach(() => vi.restoreAllMocks())

  it('captures a complete file stamp without reading payload bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-rename-identity-'))
    try {
      const file = path.join(root, 'file.motrix')
      await writeFile(file, 'payload')
      const hash = vi.spyOn(hashing, 'hashOpenedFile')
      const metadata = await stat(file, { bigint: true })
      const identity = await readRenameFileIdentity(file)
      expect(identity).toEqual({
        kind: 'rename-file',
        size: 7,
        platformFileId: `${metadata.dev}:${metadata.ino}`,
        mtimeNs: String(metadata.mtimeNs),
        ctimeNs: String(metadata.ctimeNs),
        birthtimeNs: String(metadata.birthtimeNs),
      })
      expect(artifactIdentityEquals(identity, { ...identity })).toBe(true)
      expect(artifactContentEquals(identity, identity)).toBe(false)
      for (const field of [
        'platformFileId',
        'mtimeNs',
        'ctimeNs',
        'birthtimeNs',
      ] as const) {
        expect(
          artifactIdentityEquals(identity, {
            ...identity,
            [field]: `${identity[field]}1`,
          })
        ).toBe(false)
      }
      expect(hash).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects a same-size write even after the original modification time is restored', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-rename-mutation-'))
    try {
      const file = path.join(root, 'file.motrix')
      await writeFile(file, 'before')
      await utimes(file, 100, 100)
      const before = await readRenameFileIdentity(file)
      expect(BigInt(before.ctimeNs)).toBeGreaterThan(0n)
      // Retry the edit until the filesystem advances its change-time tick.
      await expect
        .poll(
          async () => {
            await writeFile(file, 'edited')
            await utimes(file, 100, 100)
            return String((await stat(file, { bigint: true })).ctimeNs)
          },
          { timeout: 1000, interval: 10 }
        )
        .not.toBe(before.ctimeNs)
      const after = await readRenameFileIdentity(file)
      expect(after).toEqual({ ...before, ctimeNs: expect.any(String) })
      expect(BigInt(after.ctimeNs)).toBeGreaterThan(0n)
      expect(after.ctimeNs).not.toBe(before.ctimeNs)
      expect(artifactIdentityEquals(before, after)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
