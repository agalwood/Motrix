import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  artifactContentEquals,
  artifactIdentityEquals,
  readArtifactIdentity,
} from './artifact-identity'

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
