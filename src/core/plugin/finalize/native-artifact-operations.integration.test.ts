import { existsSync } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  artifactContentEquals,
  artifactIdentityEquals,
  type RenameFileArtifactIdentity,
  readArtifactIdentity,
  readRenameFileIdentity,
} from './artifact-identity'
import { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'
import { NativeFinalizeFilesystemAdapter } from './filesystem-adapter'
import { FinalizeCommitter, removalQuarantinePath } from './finalize-committer'
import * as hashing from './hash-opened-file'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const mkdirMock = vi.fn(actual.mkdir)
  return {
    ...actual,
    mkdir: mkdirMock,
    default: { ...actual, mkdir: mkdirMock },
  }
})

const binary = process.env.MOTRIX_FINALIZE_FS_TEST_BIN
  ? path.resolve(process.env.MOTRIX_FINALIZE_FS_TEST_BIN)
  : path.resolve(
      process.cwd(),
      'packages/finalize-fs/target/debug',
      process.platform === 'win32'
        ? 'motrix-finalize-fs.exe'
        : 'motrix-finalize-fs'
    )

describe.runIf(existsSync(binary))(
  'NativeFinalizeArtifactOperations integration',
  () => {
    const roots: string[] = []

    afterEach(async () => {
      vi.restoreAllMocks()
      vi.mocked(mkdir).mockReset()
      await Promise.all(
        roots
          .splice(0)
          .map((root) => rm(root, { recursive: true, force: true }))
      )
    })

    async function setup() {
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'motrix-finalize-'))
      )
      roots.push(root)
      const adapter = new NativeFinalizeFilesystemAdapter(binary)
      const operations = new NativeFinalizeArtifactOperations(adapter)
      await operations.assertSupported()
      return { root, adapter, operations }
    }

    async function writeEditWithDistinctCtime(
      source: string,
      before: RenameFileArtifactIdentity
    ): Promise<RenameFileArtifactIdentity> {
      expect(BigInt(before.ctimeNs)).toBeGreaterThan(0n)
      // Filesystems can stamp adjacent writes in the same clock tick. Establish
      // the changed ctime this fixture needs before testing rename rejection.
      await expect
        .poll(
          async () => {
            await writeFile(source, 'edited')
            await utimes(source, 100, 100)
            return String((await stat(source, { bigint: true })).ctimeNs)
          },
          { timeout: 1000, interval: 10 }
        )
        .not.toBe(before.ctimeNs)
      const after = await readRenameFileIdentity(source)
      expect(after).toEqual({ ...before, ctimeNs: expect.any(String) })
      expect(BigInt(after.ctimeNs)).toBeGreaterThan(0n)
      expect(after.ctimeNs).not.toBe(before.ctimeNs)
      return after
    }

    it.each([false, true])(
      'syncs rename directories in the native layer, retaining legacy fallback: %s',
      async (legacy) => {
        const { root, adapter, operations } = await setup()
        const source = path.join(root, 'download.motrix')
        const target = path.join(root, 'download')
        await writeFile(source, 'complete')
        const identity = await readArtifactIdentity(source)
        const realRename = adapter.renameOpenedNoReplace.bind(adapter)
        vi.spyOn(adapter, 'renameOpenedNoReplace').mockImplementation(
          async (...args) => {
            const result = await realRename(...args)
            expect(result).toEqual({ directorySyncMode: 'directory_flushed' })
            return legacy ? undefined : result
          }
        )
        const sync = vi.spyOn(adapter, 'syncRoot')
        try {
          await operations.moveNoReplace(source, identity, target)
          expect(sync).toHaveBeenCalledTimes(legacy ? 2 : 0)
          expect(await readFile(target, 'utf8')).toBe('complete')
        } finally {
          await adapter.dispose()
        }
      }
    )

    it('finalizes in an existing directory whose mkdir reports EPERM like a Windows drive root', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'archive.zip.motrix')
      const target = path.join(root, 'archive.zip')
      await writeFile(source, 'completed download')
      const identity = await readArtifactIdentity(source)
      const mkdirMock = vi.mocked(mkdir).mockRejectedValue(
        Object.assign(new Error(`EPERM: mkdir '${root}'`), {
          code: 'EPERM',
          syscall: 'mkdir',
        })
      )
      try {
        await operations.preflight(source, target)
        await operations.moveNoReplace(source, identity, target)
        expect(await readFile(target, 'utf8')).toBe('completed download')
        expect(existsSync(source)).toBe(false)
        expect(mkdirMock).not.toHaveBeenCalled()
      } finally {
        await adapter.dispose()
      }
    })

    it('finalizes a large file with at most two content reads and metadata-only native rename', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'large.part')
      const target = path.join(root, 'large.bin')
      await writeFile(source, Buffer.alloc(17 * 1024 * 1024, 0x53))
      const hash = vi.spyOn(hashing, 'hashOpenedFile')
      const nativeOpen = vi.spyOn(adapter, 'openArtifact')
      const sourceIdentity = await operations.identity(source)
      if (!sourceIdentity) throw new Error('missing fixture')
      const commitTerminal = vi.fn()
      const committer = new FinalizeCommitter({
        fs: operations,
        leases: new ArtifactMutationLeaseCoordinator([]),
        repository: {
          prepare: vi.fn(),
          checkpoint: vi.fn(),
          advance: vi.fn(),
          commitTerminal,
          quarantine: vi.fn(),
          listRecoverable: async () => [],
        },
        privatePathFor: () => path.join(root, '.private'),
        rollbackPathFor: () => path.join(root, '.rollback'),
        exactIdentity: artifactIdentityEquals,
        sameContent: artifactContentEquals,
      })
      try {
        await committer.commit({
          planId: 'large-plan',
          taskId: 'large-task',
          saveDir: root,
          sourcePath: source,
          targetPath: target,
          sourceIdentity,
          metadataOps: [],
          contributors: [],
        })
        expect(hash).toHaveBeenCalled()
        expect(hash.mock.calls.length).toBeLessThanOrEqual(2)
        expect(nativeOpen).toHaveBeenCalledWith(
          expect.anything(),
          'large.part',
          'rename'
        )
        expect(commitTerminal).toHaveBeenCalledOnce()
        expect(existsSync(source)).toBe(false)
        expect(
          (await readFile(target)).equals(Buffer.alloc(17 * 1024 * 1024, 0x53))
        ).toBe(true)
      } finally {
        await adapter.dispose()
      }
    })

    it('performs no payload reads or copies for a large suffix rename with simulated Windows exclusion', async () => {
      const { root, adapter, operations } = await setup()
      // This exercises the TypeScript protocol on the available helper. Windows
      // sharing-mode exclusion is verified by the native Windows tests.
      const capabilities = await adapter.capabilities()
      vi.spyOn(adapter, 'capabilities').mockResolvedValue({
        ...capabilities,
        platform: 'windows',
        heldFileWriteExclusion: true,
      })
      const source = path.join(root, 'archive.zip.motrix')
      const target = path.join(root, 'archive.zip')
      const fileSize = 17 * 1024 * 1024
      const file = await open(source, 'wx')
      await file.write('completed download')
      await file.truncate(fileSize)
      await file.close()
      const hash = vi.spyOn(hashing, 'hashOpenedFile')
      const copy = vi.spyOn(adapter, 'copyOpened')
      const materialize = vi.spyOn(operations, 'materializePrivate')
      const nativeOpen = vi.spyOn(adapter, 'openArtifact')
      const commitTerminal = vi.fn()
      try {
        const sourceIdentity = await operations.renameIdentity(source)
        if (!sourceIdentity) throw new Error('missing rename identity')
        const committer = new FinalizeCommitter({
          fs: operations,
          leases: new ArtifactMutationLeaseCoordinator([]),
          repository: {
            prepare: vi.fn(),
            checkpoint: vi.fn(),
            advance: vi.fn(),
            commitTerminal,
            quarantine: vi.fn(),
            listRecoverable: async () => [],
          },
          privatePathFor: () => path.join(root, '.private'),
          rollbackPathFor: () => path.join(root, '.rollback'),
          exactIdentity: artifactIdentityEquals,
          sameContent: artifactContentEquals,
        })
        const result = await committer.commit({
          planId: 'rename-only-plan',
          taskId: 'rename-only-task',
          saveDir: root,
          sourcePath: source,
          targetPath: target,
          sourceIdentity,
          metadataOps: [],
          contributors: [],
        })
        expect(result.targetIdentity).toEqual(
          await readRenameFileIdentity(target)
        )
        expect(hash).not.toHaveBeenCalled()
        expect(copy).not.toHaveBeenCalled()
        expect(materialize).not.toHaveBeenCalled()
        expect(nativeOpen).toHaveBeenCalledWith(
          expect.anything(),
          'archive.zip.motrix',
          'rename'
        )
        expect(commitTerminal).toHaveBeenCalledOnce()
        expect(existsSync(source)).toBe(false)
        expect((await stat(target)).size).toBe(fileSize)
        const published = await open(target, 'r')
        try {
          const buffer = Buffer.alloc(18)
          await published.read(buffer, 0, buffer.length, 0)
          expect(buffer.toString()).toBe('completed download')
        } finally {
          await published.close()
        }
      } finally {
        await adapter.dispose()
      }
    })

    it.each([
      { platform: 'windows', heldFileWriteExclusion: undefined },
      { platform: 'windows', heldFileWriteExclusion: false },
      { platform: 'macos', heldFileWriteExclusion: true },
      { platform: 'linux', heldFileWriteExclusion: true },
    ])(
      'requires Windows held-file write exclusion for metadata capture: %j',
      async (unsupported) => {
        const { root, adapter, operations } = await setup()
        const capabilities = await adapter.capabilities()
        vi.spyOn(adapter, 'capabilities').mockResolvedValue({
          ...capabilities,
          ...unsupported,
        })
        const source = path.join(root, 'download.motrix')
        await writeFile(source, 'payload')
        try {
          expect(await operations.renameIdentity(source)).toBeNull()
        } finally {
          await adapter.dispose()
        }
      }
    )

    it('rejects a same-size edit with restored mtime before a metadata-only rename', async () => {
      const { root, adapter, operations } = await setup()
      const capabilities = await adapter.capabilities()
      vi.spyOn(adapter, 'capabilities').mockResolvedValue({
        ...capabilities,
        platform: 'windows',
        heldFileWriteExclusion: true,
      })
      const source = path.join(root, 'download.motrix')
      const target = path.join(root, 'download')
      await writeFile(source, 'before')
      await utimes(source, 100, 100)
      const identity = await readRenameFileIdentity(source)
      const rename = vi.spyOn(adapter, 'renameOpenedNoReplace')
      const copy = vi.spyOn(adapter, 'copyOpened')
      const remove = vi.spyOn(adapter, 'removeOpened')
      try {
        await writeEditWithDistinctCtime(source, identity)
        await expect(
          operations.moveNoReplace(source, identity, target)
        ).rejects.toThrow()
        expect(rename).not.toHaveBeenCalled()
        expect(copy).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        expect(await readFile(source, 'utf8')).toBe('edited')
        expect(existsSync(target)).toBe(false)
      } finally {
        await adapter.dispose()
      }
    })

    it('rejects metadata changes between initial validation and opening the native artifact', async () => {
      const { root, adapter, operations } = await setup()
      const capabilities = await adapter.capabilities()
      vi.spyOn(adapter, 'capabilities').mockResolvedValue({
        ...capabilities,
        platform: 'windows',
        heldFileWriteExclusion: true,
      })
      const source = path.join(root, 'download.motrix')
      const target = path.join(root, 'download')
      await writeFile(source, 'before')
      await utimes(source, 100, 100)
      const identity = await readRenameFileIdentity(source)
      const openArtifact = adapter.openArtifact.bind(adapter)
      let editedIdentity: RenameFileArtifactIdentity | undefined
      vi.spyOn(adapter, 'openArtifact').mockImplementation(async (...args) => {
        editedIdentity = await writeEditWithDistinctCtime(source, identity)
        return openArtifact(...args)
      })
      const rename = vi.spyOn(adapter, 'renameOpenedNoReplace')
      const copy = vi.spyOn(adapter, 'copyOpened')
      const remove = vi.spyOn(adapter, 'removeOpened')
      try {
        await expect(
          operations.moveNoReplace(source, identity, target)
        ).rejects.toThrow()
        expect(editedIdentity).toBeDefined()
        expect(editedIdentity?.ctimeNs).not.toBe(identity.ctimeNs)
        expect(rename).not.toHaveBeenCalled()
        expect(copy).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        expect(await readFile(source, 'utf8')).toBe('edited')
        expect(existsSync(target)).toBe(false)
      } finally {
        await adapter.dispose()
      }
    })

    it('leaves directory artifacts on the content-verified path', async () => {
      const { root, adapter, operations } = await setup()
      const capabilities = await adapter.capabilities()
      vi.spyOn(adapter, 'capabilities').mockResolvedValue({
        ...capabilities,
        platform: 'windows',
        heldFileWriteExclusion: true,
      })
      const source = path.join(root, 'download.motrix')
      await mkdir(source)
      await writeFile(path.join(source, 'payload'), 'content')
      const hash = vi.spyOn(hashing, 'hashOpenedFile')
      try {
        expect(await operations.renameIdentity(source)).toBeNull()
        expect(await operations.identity(source)).toMatchObject({
          kind: 'directory',
          entryCount: 1,
          totalBytes: 7,
        })
        expect(hash).toHaveBeenCalledOnce()
      } finally {
        await adapter.dispose()
      }
    })

    it.each(['native-response', 'target-checkpoint'] as const)(
      'preserves a successful rename when its %s is lost',
      async (failure) => {
        const { root, adapter, operations } = await setup()
        const capabilities = await adapter.capabilities()
        vi.spyOn(adapter, 'capabilities').mockResolvedValue({
          ...capabilities,
          platform: 'windows',
          heldFileWriteExclusion: true,
        })
        const source = path.join(root, 'download.motrix')
        const target = path.join(root, 'download')
        await writeFile(source, 'complete payload')
        const sourceIdentity = await readRenameFileIdentity(source)
        if (failure === 'native-response') {
          const rename = adapter.renameOpenedNoReplace.bind(adapter)
          vi.spyOn(adapter, 'renameOpenedNoReplace').mockImplementation(
            async (...args) => {
              await rename(...args)
              throw new Error('rename response lost')
            }
          )
        }
        const repository = {
          prepare: vi.fn(),
          checkpoint: vi.fn(async () => {
            if (failure === 'target-checkpoint')
              throw new Error('checkpoint failed')
          }),
          advance: vi.fn(),
          commitTerminal: vi.fn(),
          quarantine: vi.fn(),
          listRecoverable: async () => [],
        }
        const move = vi.spyOn(operations, 'moveNoReplace')
        const remove = vi.spyOn(operations, 'removeKnown')
        const committer = new FinalizeCommitter({
          fs: operations,
          leases: new ArtifactMutationLeaseCoordinator([]),
          repository,
          privatePathFor: () => path.join(root, '.private'),
          rollbackPathFor: () => path.join(root, '.rollback'),
          exactIdentity: artifactIdentityEquals,
          sameContent: artifactContentEquals,
        })
        try {
          await expect(
            committer.commit({
              planId: 'ambiguous-rename',
              taskId: 'ambiguous-task',
              saveDir: root,
              sourcePath: source,
              targetPath: target,
              sourceIdentity,
              metadataOps: [],
              contributors: [],
            })
          ).rejects.toThrow('quarantined')
          expect(repository.quarantine).toHaveBeenCalledWith(
            'ambiguous-rename',
            'renamed target has no matching durable stamp'
          )
          expect(repository.commitTerminal).not.toHaveBeenCalled()
          expect(move).toHaveBeenCalledOnce()
          expect(remove).not.toHaveBeenCalled()
          expect(existsSync(source)).toBe(false)
          expect(await readFile(target, 'utf8')).toBe('complete payload')
        } finally {
          await adapter.dispose()
        }
      }
    )

    it('never copies, links, or deletes an artifact authorized only for rename', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'download.motrix')
      const target = path.join(root, 'download')
      await writeFile(source, 'payload')
      const identity = await readRenameFileIdentity(source)
      const copy = vi.spyOn(adapter, 'copyOpened')
      const link = vi.spyOn(adapter, 'linkOpenedNoReplace')
      const remove = vi.spyOn(adapter, 'removeOpened')
      try {
        await expect(
          operations.materializePrivate(source, identity, target)
        ).rejects.toThrow()
        await expect(
          operations.linkNoReplace(source, identity, target)
        ).rejects.toThrow()
        await expect(
          operations.removeKnown(source, identity, path.join(root, '.remove'))
        ).rejects.toThrow()
        expect(copy).not.toHaveBeenCalled()
        expect(link).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        expect(await readFile(source, 'utf8')).toBe('payload')
      } finally {
        await adapter.dispose()
      }
    })

    it.runIf(process.platform !== 'win32')(
      'rejects a different held isolation directory identity',
      async () => {
        const { root, adapter } = await setup()
        try {
          const metadata = await stat(root, { bigint: true })
          const held = await adapter.openRoot(
            root,
            `${metadata.dev}:${metadata.ino}`
          )
          await adapter.close(held)
          await expect(
            adapter.openRoot(root, `${metadata.dev}:${metadata.ino + 1n}`)
          ).rejects.toThrow('held directory identity changed')
        } finally {
          await adapter.dispose()
        }
      }
    )

    it('publishes a held file without replacing an existing target', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'source.bin')
      const target = path.join(root, 'target.bin')
      await writeFile(source, 'source')
      const identity = await readArtifactIdentity(source)
      await operations.moveNoReplace(source, identity, target)
      expect(await readFile(target, 'utf8')).toBe('source')

      const conflict = path.join(root, 'conflict.bin')
      await writeFile(source, 'second')
      await writeFile(conflict, 'existing')
      const secondIdentity = await readArtifactIdentity(source)
      await expect(
        operations.moveNoReplace(source, secondIdentity, conflict)
      ).rejects.toMatchObject({ code: 'target_exists' })
      expect(await readFile(source, 'utf8')).toBe('second')
      expect(await readFile(conflict, 'utf8')).toBe('existing')
      await adapter.dispose()
    })

    it('publishes a GitHub ZIP into a plugin-selected Compressed directory', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'Motrix-main.zip.motrix')
      const target = path.join(root, 'Compressed', 'Motrix-main.zip')
      await writeFile(source, 'github-zip-payload')

      await operations.moveNoReplace(
        source,
        await readArtifactIdentity(source),
        target
      )

      expect(existsSync(source)).toBe(false)
      expect(await readFile(target, 'utf8')).toBe('github-zip-payload')
      await adapter.dispose()
    })

    it('copies and publishes a directory with byte-identical identity', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'source')
      const privateTarget = path.join(root, '.private', 'copy')
      const target = path.join(root, 'target')
      await mkdir(path.join(source, 'nested'), { recursive: true })
      await writeFile(path.join(source, 'nested', 'payload'), 'payload')
      const sourceIdentity = await readArtifactIdentity(source)
      const privateIdentity = await operations.materializePrivate(
        source,
        sourceIdentity,
        privateTarget
      )
      expect(artifactContentEquals(sourceIdentity, privateIdentity)).toBe(true)
      await operations.makeDurable(privateTarget)
      await operations.moveNoReplace(privateTarget, privateIdentity, target)
      expect(
        await readFile(path.join(target, 'nested', 'payload'), 'utf8')
      ).toBe('payload')
      await adapter.dispose()
    })

    it('rejects an intermediate target symlink before publishing outside the root', async () => {
      const { root, adapter, operations } = await setup()
      const source = path.join(root, 'source.bin')
      const outside = path.join(root, 'outside')
      const redirectedParent = path.join(root, 'save', 'redirect')
      await mkdir(path.join(root, 'save'), { recursive: true })
      await mkdir(outside)
      await symlink(
        outside,
        redirectedParent,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await writeFile(source, 'source')
      const identity = await readArtifactIdentity(source)

      await expect(
        operations.moveNoReplace(
          source,
          identity,
          path.join(redirectedParent, 'target.bin')
        )
      ).rejects.toMatchObject({ code: 'artifact_unsafe_path' })
      expect(existsSync(path.join(outside, 'target.bin'))).toBe(false)
      expect(await readFile(source, 'utf8')).toBe('source')
      await adapter.dispose()
    })

    it('removes a verified file and directory through held sidecar handles', async () => {
      const { root, adapter, operations } = await setup()
      const file = path.join(root, 'file.bin')
      const tree = path.join(root, 'tree')
      await writeFile(file, 'file')
      await mkdir(path.join(tree, 'nested'), { recursive: true })
      await writeFile(path.join(tree, 'nested', 'payload'), 'payload')

      await operations.removeKnown(
        file,
        await readArtifactIdentity(file),
        removalQuarantinePath('integration-file', file)
      )
      await operations.removeKnown(
        tree,
        await readArtifactIdentity(tree),
        removalQuarantinePath('integration-tree', tree)
      )

      expect(existsSync(file)).toBe(false)
      expect(existsSync(tree)).toBe(false)
      await adapter.dispose()
    })

    it.runIf(process.platform !== 'win32').each([0o700, 0o755, 0o770, 0o777])(
      'checks exclusive directory write access during isolated cleanup (mode %s)',
      async (mode) => {
        const { root, adapter, operations } = await setup()
        const source = path.join(root, 'download.motrix')
        const target = path.join(root, 'download')
        try {
          await writeFile(source, 'complete download')
          await link(source, target)
          const identity = await readArtifactIdentity(source)
          const intent = await operations.prepareRemoval(
            source,
            identity,
            removalQuarantinePath('ntfs-mode', source)
          )
          if (!intent.isolation) throw new Error('missing isolation directory')
          // Model NTFS mount masks overriding mkdir(0700), including on replay
          // through a new operations instance with no in-memory state.
          await chmod(intent.isolation.directory, mode)
          const replay = new NativeFinalizeArtifactOperations(adapter)
          const removal = replay.removeKnown(
            source,
            identity,
            intent.quarantinePath,
            intent.isolation,
            { path: target, identity }
          )
          if (mode & 0o022) {
            await expect(removal).rejects.toThrow(
              'private isolation directory changed'
            )
            expect(await readFile(source, 'utf8')).toBe('complete download')
          } else {
            await removal
            expect(existsSync(source)).toBe(false)
            expect(existsSync(intent.isolation.directory)).toBe(false)
          }
          expect(await readFile(target, 'utf8')).toBe('complete download')
        } finally {
          await adapter.dispose()
        }
      }
    )

    it('resumes the exact journal quarantine left by a removal crash', async () => {
      const { root, adapter, operations } = await setup()
      const original = path.join(root, 'crash.bin')
      const quarantine = removalQuarantinePath('crash-journal', original)
      await writeFile(original, 'preserved')
      const identity = await readArtifactIdentity(original)
      // Exact crash point: journal intent is durable and the sidecar rename
      // completed, but the process died before unlink.
      await rename(original, quarantine)

      await operations.removeKnown(original, identity, quarantine)

      expect(existsSync(original)).toBe(false)
      expect(existsSync(quarantine)).toBe(false)
      await adapter.dispose()
    })

    it('preserves an unknown object at a persisted removal quarantine', async () => {
      const { root, adapter, operations } = await setup()
      const original = path.join(root, 'unknown.bin')
      const quarantine = removalQuarantinePath('unknown-journal', original)
      await writeFile(original, 'expected')
      const identity = await readArtifactIdentity(original)
      await rm(original)
      await writeFile(quarantine, 'unknown')

      await expect(
        operations.removeKnown(original, identity, quarantine)
      ).rejects.toMatchObject({ code: 'artifact_mutated' })
      expect(await readFile(quarantine, 'utf8')).toBe('unknown')
      await adapter.dispose()
    })
  }
)
