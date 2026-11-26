import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalizeFinalizeCommitRequest,
  canonicalizeSaveDir,
} from './canonicalize-save-dir'

let root: string

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-canonical-savedir-'))
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('canonicalizeSaveDir', () => {
  it('resolves a symlinked save directory to its real physical path', async () => {
    const externalDir = path.join(root, 'external-volume', 'Downloads')
    const symlinkDir = path.join(root, 'Downloads')
    await mkdir(externalDir, { recursive: true })
    await symlink(externalDir, symlinkDir)

    await expect(canonicalizeSaveDir(symlinkDir)).resolves.toBe(externalDir)
  })

  it('resolves existing symlinked ancestors while keeping not-yet-created subdirectories', async () => {
    const externalDir = path.join(root, 'external-volume', 'Downloads')
    const symlinkDir = path.join(root, 'Downloads')
    await mkdir(externalDir, { recursive: true })
    await symlink(externalDir, symlinkDir)

    const nested = path.join(symlinkDir, 'Archives', '2026')
    await expect(canonicalizeSaveDir(nested)).resolves.toBe(
      path.join(externalDir, 'Archives', '2026')
    )
  })

  it('returns original input for non-directory or broken symlink targets', async () => {
    const filePath = path.join(root, 'plain.txt')
    await writeFile(filePath, 'hello')
    const broken = path.join(root, 'broken-link')
    await symlink(path.join(root, 'non-existent'), broken)

    await expect(canonicalizeSaveDir(filePath)).resolves.toBe(filePath)
    await expect(canonicalizeSaveDir(broken)).resolves.toBe(broken)
  })
})

describe('canonicalizeFinalizeCommitRequest', () => {
  it('rebases symlinked saveDir paths for legacy tasks without resolving inner symlinks', async () => {
    const externalDir = path.join(root, 'external-volume', 'Downloads')
    const outsideDir = path.join(root, 'outside')
    const symlinkDir = path.join(root, 'Downloads')
    await mkdir(externalDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await symlink(externalDir, symlinkDir)
    // 内部恶意子目录符号链接不得被展开，留给 finalize-fs 的 O_NOFOLLOW 拦截
    await symlink(outsideDir, path.join(externalDir, 'evil-sub'))

    const sourcePath = path.join(symlinkDir, 'archive.zip.motrix')
    const targetPath = path.join(symlinkDir, 'evil-sub', 'archive.zip')
    const task = makeDownloadTask({
      saveDir: symlinkDir,
      diskPath: sourcePath,
      finalPath: targetPath,
      instances: [
        {
          id: 'inst-1',
          engineTaskId: 'gid-1',
          role: 'primary',
          diskPath: sourcePath,
        } as never,
      ],
    })

    const normalized = await canonicalizeFinalizeCommitRequest({
      task,
      sourcePath,
      targetPath,
    })

    expect(normalized.task.saveDir).toBe(externalDir)
    expect(normalized.sourcePath).toBe(
      path.join(externalDir, 'archive.zip.motrix')
    )
    // 内部 evil-sub 保持原相对名，绝不被解析成 outsideDir
    expect(normalized.targetPath).toBe(
      path.join(externalDir, 'evil-sub', 'archive.zip')
    )
    expect(normalized.task.diskPath).toBe(
      path.join(externalDir, 'archive.zip.motrix')
    )
    expect(normalized.task.finalPath).toBe(
      path.join(externalDir, 'evil-sub', 'archive.zip')
    )
    expect(normalized.task.instances[0]?.diskPath).toBe(
      path.join(externalDir, 'archive.zip.motrix')
    )
  })

  it('leaves paths outside saveDir untouched', async () => {
    const externalDir = path.join(root, 'external-volume', 'Downloads')
    const otherDir = path.join(root, 'other')
    const symlinkDir = path.join(root, 'Downloads')
    await mkdir(externalDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    await symlink(externalDir, symlinkDir)

    const sourcePath = path.join(symlinkDir, 'file.bin.motrix')
    const outsideTarget = path.join(otherDir, 'file.bin')
    const task = makeDownloadTask({
      saveDir: symlinkDir,
      diskPath: sourcePath,
      finalPath: outsideTarget,
    })

    const normalized = await canonicalizeFinalizeCommitRequest({
      task,
      sourcePath,
      targetPath: outsideTarget,
    })

    expect(normalized.sourcePath).toBe(
      path.join(externalDir, 'file.bin.motrix')
    )
    expect(normalized.targetPath).toBe(outsideTarget)
  })
})
