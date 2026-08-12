import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareServerRuntimeDirectories } from './runtime-directories'

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

describe('prepareServerRuntimeDirectories', () => {
  it('creates writable persistent data, temp, and torrent roots', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'motrix-runtime-dir-'))
    cleanup.push(parent)
    const dataDir = path.join(parent, 'data')

    const result = await prepareServerRuntimeDirectories({ dataDir })

    expect(result).toEqual({
      dataDir,
      tempDir: path.join(dataDir, 'tmp'),
      torrentsDir: path.join(dataDir, 'torrents'),
      homeDir: path.join(dataDir, 'home'),
    })
    await expect(stat(result.tempDir)).resolves.toBeDefined()
    await expect(stat(result.torrentsDir)).resolves.toBeDefined()
    await expect(stat(result.homeDir)).resolves.toBeDefined()
  })

  it('rejects relative data and temp configuration', async () => {
    await expect(
      prepareServerRuntimeDirectories({ dataDir: 'data' })
    ).rejects.toThrow('MOTRIX_DATA_DIR must be an absolute path')
    const parent = await mkdtemp(path.join(tmpdir(), 'motrix-runtime-dir-'))
    cleanup.push(parent)
    await expect(
      prepareServerRuntimeDirectories({
        dataDir: parent,
        tempDirValue: 'tmp',
      })
    ).rejects.toThrow('MOTRIX_TEMP_DIR must be an absolute path')
  })
})
