import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rmdir,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import {
  type ArtifactIdentity,
  ArtifactIdentityCache,
  ArtifactIdentityError,
  artifactIdentityEquals,
  readArtifactIdentity,
} from './artifact-identity'
import type { FinalizeFilesystemAdapter } from './filesystem-adapter'
import type {
  FinalizeArtifactOperations,
  FinalizeIsolation,
  FinalizeRemovalIntent,
  FinalizeRemovalSurvivor,
} from './finalize-committer'

/**
 * Production artifact operations. No-replace publication is delegated to the
 * native sidecar, which holds the source artifact and both parent roots while
 * performing the rename. Copy staging is private, exclusive, identity-checked,
 * and made durable before publication.
 */
export class NativeFinalizeArtifactOperations
  implements FinalizeArtifactOperations
{
  private readonly identityCache = new ArtifactIdentityCache()

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

  async preflight(sourcePath: string, targetPath: string): Promise<void> {
    await this.assertSupported()
    await this.ensureSafeDirectory(path.dirname(targetPath))
    await this.makeDurable(sourcePath)
    const targetRoot = await this.adapter.openRoot(path.dirname(targetPath))
    try {
      await this.adapter.syncRoot(targetRoot)
    } finally {
      await this.adapter.close(targetRoot).catch(() => undefined)
    }
  }

  async identity(artifactPath: string): Promise<ArtifactIdentity | null> {
    try {
      return await readArtifactIdentity(artifactPath, {
        cache: this.identityCache,
      })
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
    await this.assertSupported()
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
    let targetRoot: Awaited<ReturnType<typeof this.adapter.openRoot>> | null =
      null
    let artifact: Awaited<ReturnType<typeof this.adapter.openArtifact>> | null =
      null
    try {
      targetRoot = await this.adapter.openRoot(path.dirname(privateTargetPath))
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
      if (targetRoot)
        await this.adapter.close(targetRoot).catch(() => undefined)
    }
    const copied = await readArtifactIdentity(privateTargetPath, {
      cache: this.identityCache,
    })
    await this.requireIdentity(sourcePath, expected)
    await this.assertSafeExistingParent(privateTargetPath)
    return copied
  }

  async moveNoReplace(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void> {
    return this.publishOpened(sourcePath, expected, targetPath, 'rename')
  }

  async linkNoReplace(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void> {
    return this.publishOpened(sourcePath, expected, targetPath, 'link')
  }

  private async publishOpened(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string,
    method: 'rename' | 'link'
  ): Promise<void> {
    await this.assertSupported()
    await this.requireIdentity(sourcePath, expected)
    await this.ensureSafeDirectory(path.dirname(targetPath))
    const sourceRoot = await this.adapter.openRoot(path.dirname(sourcePath))
    let targetRoot: Awaited<ReturnType<typeof this.adapter.openRoot>> | null =
      null
    let artifact: Awaited<ReturnType<typeof this.adapter.openArtifact>> | null =
      null
    try {
      targetRoot = await this.adapter.openRoot(path.dirname(targetPath))
      artifact = await this.adapter.openArtifact(
        sourceRoot,
        path.basename(sourcePath),
        'rename'
      )
      await this.requireIdentity(sourcePath, expected)
      if (method === 'link') {
        await this.adapter.linkOpenedNoReplace(
          artifact,
          targetRoot,
          path.basename(targetPath)
        )
      } else {
        await this.adapter.renameOpenedNoReplace(
          artifact,
          targetRoot,
          path.basename(targetPath)
        )
      }
      await this.adapter.syncRoot(sourceRoot)
      await this.adapter.syncRoot(targetRoot)
      await this.requireIdentity(targetPath, expected)
    } finally {
      if (artifact) await this.adapter.close(artifact).catch(() => undefined)
      await this.adapter.close(sourceRoot).catch(() => undefined)
      if (targetRoot)
        await this.adapter.close(targetRoot).catch(() => undefined)
    }
  }

  async makeDurable(artifactPath: string): Promise<void> {
    await this.assertSupported()
    await syncTree(artifactPath, this.adapter)
    const root = await this.adapter.openRoot(path.dirname(artifactPath))
    try {
      await this.adapter.syncRoot(root)
    } finally {
      await this.adapter.close(root).catch(() => undefined)
    }
  }

  async prepareRemoval(
    artifactPath: string,
    identity: ArtifactIdentity,
    quarantinePath: string
  ): Promise<FinalizeRemovalIntent> {
    await this.assertSupported()
    if (process.platform === 'win32' || identity.kind !== 'file') {
      return { artifactPath, identity, quarantinePath }
    }
    await this.assertSafeExistingParent(artifactPath)
    const directory = await mkdtemp(`${quarantinePath}-`)
    const value = await lstat(directory, { bigint: true })
    const isolation = { directory, platformFileId: `${value.dev}:${value.ino}` }
    const held = await this.adapter.openRoot(directory)
    try {
      await this.adapter.syncRoot(held)
    } finally {
      await this.adapter.close(held)
    }
    const parent = await this.adapter.openRoot(path.dirname(directory))
    try {
      await this.adapter.syncRoot(parent)
    } finally {
      await this.adapter.close(parent)
    }
    return {
      artifactPath,
      identity,
      quarantinePath: path.join(directory, 'payload'),
      isolation,
    }
  }

  private async assertIsolation(
    isolation: FinalizeIsolation
  ): Promise<boolean> {
    try {
      const stat = await lstat(isolation.directory, { bigint: true })
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        `${stat.dev}:${stat.ino}` !== isolation.platformFileId ||
        (stat.mode & 0o777n) !== 0o700n
      ) {
        throw new ArtifactIdentityError(
          'artifact_mutated',
          'private isolation directory changed'
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    return true
  }

  private async removeIsolated(
    artifactPath: string,
    expected: ArtifactIdentity,
    quarantinePath: string,
    isolation: FinalizeIsolation,
    survivor?: FinalizeRemovalSurvivor
  ): Promise<void> {
    if (
      expected.kind !== 'file' ||
      path.dirname(isolation.directory) !== path.dirname(artifactPath) ||
      quarantinePath !== path.join(isolation.directory, 'payload')
    ) {
      throw new ArtifactIdentityError(
        'artifact_unsafe_path',
        'invalid private removal intent'
      )
    }
    if (!(await this.assertIsolation(isolation))) {
      if (await this.identity(artifactPath))
        throw new ArtifactIdentityError(
          'artifact_mutated',
          'private removal directory is missing'
        )
      const parent = await this.adapter.openRoot(path.dirname(artifactPath))
      try {
        await this.adapter.syncRoot(parent)
      } finally {
        await this.adapter.close(parent)
      }
      return
    }
    const original = await this.identity(artifactPath)
    const isolated = await this.identity(quarantinePath)
    if (
      (original && isolated) ||
      (original && !artifactIdentityEquals(original, expected)) ||
      (isolated && !artifactIdentityEquals(isolated, expected))
    ) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        'private removal identity mismatch'
      )
    }
    const root = await this.adapter.openRoot(
      isolation.directory,
      isolation.platformFileId
    )
    try {
      if (original) {
        const sourceRoot = await this.adapter.openRoot(
          path.dirname(artifactPath)
        )
        let artifact:
          | Awaited<ReturnType<typeof this.adapter.openArtifact>>
          | undefined
        try {
          artifact = await this.adapter.openArtifact(
            sourceRoot,
            path.basename(artifactPath),
            'rename'
          )
          await this.requireIdentity(artifactPath, expected)
          await this.adapter.isolateOpened(
            artifact,
            root,
            'payload',
            isolation.platformFileId
          )
        } finally {
          if (artifact)
            await this.adapter.close(artifact).catch(() => undefined)
          await this.adapter.close(sourceRoot).catch(() => undefined)
        }
      }
      if (original || isolated) {
        const artifact = await this.adapter.openArtifact(root, 'payload')
        try {
          await this.requireIdentity(quarantinePath, expected)
          await this.removeOpenedPreserving(artifact, 'payload', true, survivor)
        } finally {
          await this.adapter.close(artifact).catch(() => undefined)
        }
      }
      await this.adapter.syncRoot(root)
    } finally {
      await this.adapter.close(root).catch(() => undefined)
    }
    if (
      (await this.identity(artifactPath)) ||
      (await this.identity(quarantinePath))
    ) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        'name survived private removal'
      )
    }
    if (await this.assertIsolation(isolation)) await rmdir(isolation.directory)
    const parent = await this.adapter.openRoot(path.dirname(artifactPath))
    try {
      await this.adapter.syncRoot(parent)
    } finally {
      await this.adapter.close(parent)
    }
  }

  async removeKnown(
    artifactPath: string,
    expected: ArtifactIdentity,
    quarantinePath: string,
    isolation?: FinalizeIsolation,
    survivor?: FinalizeRemovalSurvivor
  ): Promise<void> {
    await this.assertSupported()
    if (isolation)
      return this.removeIsolated(
        artifactPath,
        expected,
        quarantinePath,
        isolation,
        survivor
      )
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
      await this.removeOpenedPreserving(
        artifact,
        path.basename(quarantinePath),
        resumeIsolated,
        survivor
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

  private async removeOpenedPreserving(
    artifact: Parameters<FinalizeFilesystemAdapter['removeOpened']>[0],
    quarantineRelative: string,
    resumeIsolated: boolean,
    survivor?: FinalizeRemovalSurvivor
  ): Promise<void> {
    if (!survivor) {
      return this.adapter.removeOpened(
        artifact,
        quarantineRelative,
        resumeIsolated
      )
    }
    // Windows retains its handle-bound deletion contract. Unix additionally
    // checks the held surviving name after hashing, immediately before unlink.
    if (process.platform === 'win32') {
      await this.requireIdentity(survivor.path, survivor.identity)
      return this.adapter.removeOpened(
        artifact,
        quarantineRelative,
        resumeIsolated
      )
    }
    const root = await this.adapter.openRoot(path.dirname(survivor.path))
    let held:
      | Awaited<ReturnType<FinalizeFilesystemAdapter['openArtifact']>>
      | undefined
    try {
      held = await this.adapter.openArtifact(
        root,
        path.basename(survivor.path),
        'rename'
      )
      await this.requireIdentity(survivor.path, survivor.identity)
      await this.adapter.removeOpened(
        artifact,
        quarantineRelative,
        resumeIsolated,
        held
      )
    } finally {
      if (held) await this.adapter.close(held).catch(() => undefined)
      await this.adapter.close(root).catch(() => undefined)
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
    const actual = await readArtifactIdentity(artifactPath, {
      cache: this.identityCache,
    })
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
