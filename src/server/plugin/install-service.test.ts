import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerPluginInstallService } from './install-service'

let root: string
let pluginsDir: string
let incomingDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'motrix-server-install-'))
  pluginsDir = path.join(root, 'plugins')
  incomingDir = path.join(root, 'incoming')
  await Promise.all([mkdir(pluginsDir), mkdir(incomingDir)])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeService(overrides: Record<string, unknown> = {}) {
  const stage = vi.fn(
    async (_moextPath: string, _source: unknown, _options: unknown) => ({
      stagingId: 's1',
      consent: {} as never,
      committed: false,
    })
  )
  const service = new ServerPluginInstallService({
    installer: { stage } as never,
    registryClient: { get: vi.fn() } as never,
    hostVersion: '2.0.0',
    pluginsDir,
    allowedLocalRoots: [incomingDir],
    ...overrides,
  })
  return { service, stage }
}

describe('ServerPluginInstallService', () => {
  it('accepts a local package only from an allowed import root', async () => {
    const packagePath = path.join(incomingDir, 'fixture.moext')
    await writeFile(packagePath, 'fixture')
    const { service, stage } = makeService()
    const canonicalPackagePath = await realpath(packagePath)

    await service.stage({
      sourceType: 'local',
      absPath: packagePath,
      fileHash: 'a'.repeat(64),
    })

    expect(stage).toHaveBeenCalledWith(
      canonicalPackagePath,
      {
        type: 'local',
        absPath: canonicalPackagePath,
        fileHash: 'a'.repeat(64),
      },
      { expect: undefined }
    )
  })

  it('rejects local paths outside the configured import roots', async () => {
    const packagePath = path.join(root, 'outside.moext')
    await writeFile(packagePath, 'fixture')
    const { service } = makeService()

    await expect(
      service.stage({
        sourceType: 'local',
        absPath: packagePath,
        fileHash: 'a'.repeat(64),
      })
    ).rejects.toMatchObject({
      message: 'plugin.install.local_path_not_allowed',
    })
  })

  it('downloads a URL package into the persistent work root and cleans it after staging', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(new Response('plugin-bytes', { status: 200 }))
    ) as unknown as typeof fetch
    const { service, stage } = makeService({ fetchImpl })

    await service.stage({
      sourceType: 'url',
      url: 'https://plugins.example/test.moext',
    })

    const stagedPath = stage.mock.calls[0]?.[0] as string
    expect(stagedPath).toContain(path.join(pluginsDir, '_downloads'))
    await expect(readdir(path.join(pluginsDir, '_downloads'))).resolves.toEqual(
      []
    )
  })

  it('rejects non-http URL sources before fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { service } = makeService({ fetchImpl })
    await expect(
      service.stage({ sourceType: 'url', url: 'file:///tmp/plugin.moext' })
    ).rejects.toMatchObject({ message: 'plugin.install.invalid_url' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
