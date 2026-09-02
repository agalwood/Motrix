import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type ArtifactIdentity,
  ArtifactIdentityError,
  artifactIdentityEquals,
  readArtifactIdentity,
} from './artifact-identity'
import type { FinalizeFilesystemAdapter } from './filesystem-adapter'
import type { FinalizeArtifactOperations } from './finalize-committer'

/**
 * Production artifact operations. No-replace publication is delegated to the
 * native sidecar, which holds the source artifact and both parent roots while
 * performing the rename. Copy staging is private, exclusive, identity-checked,
 * and made durable before publication.
 */
export class NativeFinalizeArtifactOperations
  implements FinalizeArtifactOperations
{
  constructor(private readonly adapter: FinalizeFilesystemAdapter) {}

  async assertSupported(): Promise<void> {
    const capabilities = await this.adapter.capabilities()
    if (
      !capabilities.renameNoReplace ||
      !capabilities.heldRoots ||
      !capabilities.heldArtifacts ||
      !capabilities.directorySync
    ) {
      throw new Error(
        `finalize filesystem safety is unsupported on ${capabilities.platform}`
      )
    }
  }

  async identity(artifactPath: string): Promise<ArtifactIdentity | null> {
    try {
      return await readArtifactIdentity(artifactPath)
    } catch (error) {
      if (
        error instanceof ArtifactIdentityError &&
        error.code === 'artifact_missing'
      ) {
        return null
      }
      throw error
    }
  }

  async sameFilesystem(leftPath: string, rightPath: string): Promise<boolean> {
    const left = await stat(leftPath, { bigint: true })
    const right = await statExistingAncestor(rightPath)
    return left.dev === right.dev
  }

  async materializePrivate(
    sourcePath: string,
    expected: ArtifactIdentity,
    privateTargetPath: string
  ): Promise<ArtifactIdentity> {
    await this.requireIdentity(sourcePath, expected)
    await this.ensureSafeDirectory(path.dirname(privateTargetPath))
    await this.assertSafeExistingParent(sourcePath)
    const source = await lstat(sourcePath)
    if (source.isSymbolicLink()) {
      throw new ArtifactIdentityError(
        'artifact_unsafe_path',
        `artifact root is a symbolic link: ${sourcePath}`
      )
    }
    if (!source.isDirectory() && !source.isFile()) {
      throw new ArtifactIdentityError(
        'artifact_special_file',
        `artifact is not a regular file or directory: ${sourcePath}`
      )
    }
    const sourceRoot = await this.adapter.openRoot(path.dirname(sourcePath))
    const targetRoot = await this.adapter.openRoot(
      path.dirname(privateTargetPath)
    )
    let artifact: Awaited<ReturnType<typeof this.adapter.openArtifact>> | null =
      null
    try {
      artifact = await this.adapter.openArtifact(
        sourceRoot,
        path.basename(sourcePath)
      )
      await this.requireIdentity(sourcePath, expected)
      await this.adapter.copyOpened(
        artifact,
        targetRoot,
        path.basename(privateTargetPath)
      )
    } finally {
      if (artifact) await this.adapter.close(artifact).catch(() => undefined)
      await this.adapter.close(sourceRoot).catch(() => undefined)
      await this.adapter.close(targetRoot).catch(() => undefined)
    }
    const copied = await readArtifactIdentity(privateTargetPath)
    await this.requireIdentity(sourcePath, expected)
    await this.assertSafeExistingParent(privateTargetPath)
    return copied
  }

  async moveNoReplace(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void> {
    await this.assertSupported()
    await this.requireIdentity(sourcePath, expected)
    await this.ensureSafeDirectory(path.dirname(targetPath))
    const sourceRoot = await this.adapter.openRoot(path.dirname(sourcePath))
    const targetRoot = await this.adapter.openRoot(path.dirname(targetPath))
    let artifact: Awaited<ReturnType<typeof this.adapter.openArtifact>> | null =
      null
    try {
      artifact = await this.adapter.openArtifact(
        sourceRoot,
        path.basename(sourcePath)
      )
      await this.requireIdentity(sourcePath, expected)
      await this.adapter.renameOpenedNoReplace(
        artifact,
        targetRoot,
        path.basename(targetPath)
      )
      await this.adapter.syncRoot(sourceRoot)
      await this.adapter.syncRoot(targetRoot)
      await this.requireIdentity(targetPath, expected)
    } finally {
      if (artifact) await this.adapter.close(artifact).catch(() => undefined)
      await this.adapter.close(sourceRoot).catch(() => undefined)
      await this.adapter.close(targetRoot).catch(() => undefined)
    }
  }

  async makeDurable(artifactPath: string): Promise<void> {
    await syncTree(artifactPath, this.adapter)
    const root = await this.adapter.openRoot(path.dirname(artifactPath))
    try {
      await this.adapter.syncRoot(root)
    } finally {
      await this.adapter.close(root).catch(() => undefined)
    }
  }

  async removeKnown(
    artifactPath: string,
    expected: ArtifactIdentity,
    quarantinePath: string
  ): Promise<void> {
    if (
      path.dirname(quarantinePath) !== path.dirname(artifactPath) ||
      path.basename(quarantinePath) === path.basename(artifactPath)
    ) {
      throw new ArtifactIdentityError(
        'artifact_unsafe_path',
        'removal quarantine must be a distinct sibling of the artifact'
      )
    }
    const original = await this.identity(artifactPath)
    const quarantined = await this.identity(quarantinePath)
    if (original && !artifactIdentityEquals(original, expected)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `artifact identity changed: ${artifactPath}`
      )
    }
    if (quarantined && !artifactIdentityEquals(quarantined, expected)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `removal quarantine identity changed: ${quarantinePath}`
      )
    }
    if (original && quarantined) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `artifact and removal quarantine both exist: ${artifactPath}`
      )
    }
    if (!original && !quarantined) return

    const resumeIsolated = original === null
    const openedPath = resumeIsolated ? quarantinePath : artifactPath
    const parent = await this.adapter.openRoot(path.dirname(openedPath))
    let artifact: Awaited<ReturnType<typeof this.adapter.openArtifact>> | null =
      null
    try {
      artifact = await this.adapter.openArtifact(
        parent,
        path.basename(openedPath)
      )
      await this.requireIdentity(openedPath, expected)
      await this.adapter.removeOpened(
        artifact,
        path.basename(quarantinePath),
        resumeIsolated
      )
    } finally {
      if (artifact) await this.adapter.close(artifact).catch(() => undefined)
      await this.adapter.close(parent).catch(() => undefined)
    }
    if ((await this.identity(quarantinePath)) !== null) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `removal quarantine survived deletion: ${quarantinePath}`
      )
    }
    const replacement = await this.identity(artifactPath)
    if (replacement) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `artifact name was replaced during removal: ${artifactPath}`
      )
    }
  }

  private async ensureSafeDirectory(directoryPath: string): Promise<void> {
    await assertExistingAncestorsAreDirectories(directoryPath)
    await mkdir(directoryPath, { recursive: true })
    const held = await this.adapter.openRoot(directoryPath)
    await this.adapter.close(held).catch(() => undefined)
  }

  private async assertSafeExistingParent(artifactPath: string): Promise<void> {
    const held = await this.adapter.openRoot(path.dirname(artifactPath))
    await this.adapter.close(held).catch(() => undefined)
  }

  private async requireIdentity(
    artifactPath: string,
    expected: ArtifactIdentity
  ): Promise<void> {
    const actual = await readArtifactIdentity(artifactPath)
    if (!artifactIdentityEquals(actual, expected)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `artifact identity changed: ${artifactPath}`
      )
    }
  }
}

async function assertExistingAncestorsAreDirectories(
  candidate: string
): Promise<void> {
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const component of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ArtifactIdentityError(
          'artifact_unsafe_path',
          `artifact path contains an unsafe directory: ${current}`
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function statExistingAncestor(candidate: string) {
  let current = candidate
  for (;;) {
    try {
      return await stat(current, { bigint: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function syncTree(
  artifactPath: string,
  adapter: FinalizeFilesystemAdapter
): Promise<void> {
  const entry = await lstat(artifactPath)
  if (entry.isSymbolicLink()) {
    throw new ArtifactIdentityError(
      'artifact_unsafe_path',
      `cannot durably sync a symbolic link: ${artifactPath}`
    )
  }
  if (entry.isDirectory()) {
    const children = await readdir(artifactPath)
    for (const child of children) {
      await syncTree(path.join(artifactPath, child), adapter)
    }
    const root = await adapter.openRoot(artifactPath)
    try {
      await adapter.syncRoot(root)
    } finally {
      await adapter.close(root).catch(() => undefined)
    }
    return
  }
  const handle = await open(
    artifactPath,
    (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW
  )
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
