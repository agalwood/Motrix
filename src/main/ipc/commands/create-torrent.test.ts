import { EventEmitter } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseTorrent } from '@motrix/torrent'
import { Commands } from '@shared/protocol/commands'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { torrentCreatorHandlers } from './create-torrent'

const staging = vi.hoisted(() => ({
  afterCreate: undefined as undefined | (() => Promise<void>),
  noHardLinks: false,
}))
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>()
  return {
    ...fs,
    link: async (from: string, to: string) => {
      if (staging.noHardLinks)
        throw Object.assign(new Error('Unsupported'), { code: 'EOPNOTSUPP' })
      await fs.link(from, to)
    },
    mkdtemp: async (prefix: string) => {
      const created = await fs.mkdtemp(prefix)
      if (path.basename(prefix) === '.motrix-torrent-')
        await staging.afterCreate?.()
      return created
    },
  }
})
const { pick, save } = vi.hoisted(() => ({ pick: vi.fn(), save: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: pick, showSaveDialog: save },
}))
let dir: string
const owner = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  send: vi.fn(),
}) as unknown as WebContents
const seed = vi.fn()
let handlers: ReturnType<typeof torrentCreatorHandlers>
beforeEach(async () => {
  vi.resetAllMocks()
  staging.afterCreate = undefined
  staging.noHardLinks = false
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'creator-ipc-')))
  handlers = torrentCreatorHandlers((sender) => sender === owner, seed)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
async function source(kind: 'file' | 'directory' = 'file') {
  const item = path.join(dir, 'data')
  if (kind === 'directory') {
    await mkdir(item)
    await writeFile(path.join(item, 'item'), 'abc')
  } else await writeFile(item, 'abc')
  pick.mockResolvedValue({ canceled: false, filePaths: [item] })
  await handlers[Commands.PickTorrentSource](owner, kind)
  expect(pick).toHaveBeenCalledWith(
    {},
    { properties: [kind === 'file' ? 'openFile' : 'openDirectory'] }
  )
  return item
}
it('rejects concurrent hashes and never trusts a renderer-provided source or artifact', async () => {
  await source()
  await expect(
    handlers[Commands.CreateTorrent](owner, { sourcePath: dir })
  ).rejects.toThrow()
  const [first, second] = await Promise.allSettled([
    handlers[Commands.CreateTorrent](owner, {}),
    handlers[Commands.CreateTorrent](owner, {}),
  ])
  expect(first.status).toBe('fulfilled')
  expect(second.status).toBe('rejected')
  const regenerated = await handlers[Commands.CreateTorrent](owner, {
    comment: 'updated',
  })
  if (first.status !== 'fulfilled') throw Error('Missing first result')
  await expect(
    handlers[Commands.SaveTorrentFile](owner, {
      id: first.value.id,
      seed: false,
    })
  ).rejects.toThrow()
  await expect(
    handlers[Commands.SaveTorrentFile](owner, {
      id: regenerated.id,
      seed: false,
      torrentBase64: 'fake',
    })
  ).rejects.toThrow()
  expect(save).not.toHaveBeenCalled()
})
it('preserves the result on save cancellation, protects source members, and saves without seeding', async () => {
  const folder = await source('directory')
  const result = await handlers[Commands.CreateTorrent](owner, {})
  const commit = () =>
    handlers[Commands.SaveTorrentFile](owner, { id: result.id, seed: false })
  save.mockResolvedValueOnce({ canceled: true })
  expect(await commit()).toBeNull()
  save.mockResolvedValueOnce({
    canceled: false,
    filePath: path.join(folder, 'item'),
  })
  await expect(commit()).rejects.toThrow()
  expect(await readFile(path.join(folder, 'item'), 'utf8')).toBe('abc')
  const target = path.join(dir, 'export.torrent')
  save.mockResolvedValue({ canceled: false, filePath: target })
  expect(await commit()).toEqual({ path: target, seeding: 'not-requested' })
  expect(
    parseTorrent(new Uint8Array(await readFile(target))).v1?.multiFile
  ).toBe(true)
  expect(seed).not.toHaveBeenCalled()
  await expect(commit()).rejects.toThrow()
})
it('reports a successful save separately from a rejected adoption', async () => {
  await source()
  const result = await handlers[Commands.CreateTorrent](owner, {})
  const target = path.join(dir, 'export.torrent')
  save.mockResolvedValue({ canceled: false, filePath: target })
  seed.mockResolvedValue({ outcome: 'conflict' })
  expect(
    await handlers[Commands.SaveTorrentFile](owner, {
      id: result.id,
      seed: true,
    })
  ).toEqual({ path: target, seeding: 'failed' })
  expect(seed).toHaveBeenCalledWith(
    expect.objectContaining({
      saveDir: dir,
      duplicatePolicy: 'use-existing',
      selectedFiles: [0],
    })
  )
  expect((await readFile(target)).length).toBeGreaterThan(0)
})

it('rejects a replacement source picked under the original filename', async () => {
  const file = await source()
  await rename(file, `${file}.original`)
  await writeFile(file, 'unselected replacement')
  await expect(handlers[Commands.CreateTorrent](owner, {})).rejects.toThrow(
    'replaced'
  )
  expect(save).not.toHaveBeenCalled()
})

it.each([false, true])(
  'preserves a competing file (volume without hard links: %s)',
  async (noHardLinks) => {
    staging.noHardLinks = noHardLinks
    const folder = await source('directory')
    const result = await handlers[Commands.CreateTorrent](owner, {})
    const target = path.join(folder, 'new.torrent')
    save.mockResolvedValue({ canceled: false, filePath: target })
    staging.afterCreate = () =>
      writeFile(target, 'other writer', { flag: 'wx' })
    await expect(
      handlers[Commands.SaveTorrentFile](owner, { id: result.id, seed: false })
    ).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('other writer')
    expect(seed).not.toHaveBeenCalled()
  }
)
