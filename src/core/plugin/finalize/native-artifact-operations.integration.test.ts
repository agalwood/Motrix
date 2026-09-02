import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifactContentEquals,
  readArtifactIdentity,
} from './artifact-identity'
import { NativeFinalizeFilesystemAdapter } from './filesystem-adapter'
import { removalQuarantinePath } from './finalize-committer'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

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
