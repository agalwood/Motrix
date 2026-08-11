import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerPluginsDir } from './plugins-dir'

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

describe('resolveServerPluginsDir', () => {
  it('creates the persistent plugin working directories', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-dir-'))
    cleanup.push(dataDir)
    const result = await resolveServerPluginsDir(dataDir, {})

    expect(result.pluginsDir).toBe(path.join(dataDir, 'plugins'))
    expect(result.pluginImportRoots).toEqual([])
    await expect(
      Promise.all(
        ['_downloads', '_logs', '_staging', '_uploads'].map((name) =>
          stat(path.join(result.pluginsDir, name))
        )
      )
    ).resolves.toHaveLength(4)
  })

  it('removes abandoned package and extraction staging at startup', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-dir-'))
    cleanup.push(dataDir)
    const stale = path.join(dataDir, 'plugins', '_staging', 'abandoned')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'partial'), 'partial')

    const result = await resolveServerPluginsDir(dataDir, {})

    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      stat(path.join(result.pluginsDir, '_staging'))
    ).resolves.toBeDefined()
  })

  it('rejects relative configured directories', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-dir-'))
    cleanup.push(dataDir)
    await expect(
      resolveServerPluginsDir(dataDir, { MOTRIX_PLUGIN_DIR: 'plugins' })
    ).rejects.toThrow('MOTRIX_PLUGIN_DIR must be an absolute path')
  })

  it('resolves existing import roots', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-dir-'))
    cleanup.push(dataDir)
    const incoming = path.join(dataDir, 'incoming')
    await mkdir(incoming)
    const result = await resolveServerPluginsDir(dataDir, {
      MOTRIX_PLUGIN_IMPORT_DIRS: incoming,
    })
    expect(result.pluginImportRoots).toEqual([await realpath(incoming)])
  })
})
