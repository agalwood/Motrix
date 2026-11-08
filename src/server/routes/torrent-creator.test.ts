// @vitest-environment node
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
import { parseTorrent } from '@motrix/torrent'
import {
  TORRENT_CREATOR_API,
  TORRENT_SEED_HEADER,
} from '@shared/schemas/create-torrent'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServerDownloadPathPolicy } from '../download-path-policy'
import { createApp } from '../http/app'

const token = 'torrent-creator-test-operator-token'
let root: string, allowed: string, app: FastifyInstance
let deny = false
let hold: Promise<void> | undefined
const seed = vi.fn()
const headers = { authorization: `Bearer ${token}` }
const start = (source: string, kind: 'file' | 'directory' = 'file') =>
  app.inject({
    method: 'POST',
    url: TORRENT_CREATOR_API,
    headers,
    payload: { source: { path: source, kind }, options: {} },
  })
async function wait(id: string) {
  const status = () =>
    app
      .inject({ url: `${TORRENT_CREATOR_API}/${id}`, headers })
      .then((r) => r.json())
  await expect.poll(async () => (await status()).state).not.toBe('hashing')
  return status()
}
const exp = (id: string, doSeed: boolean) =>
  app.inject({
    method: 'POST',
    url: `${TORRENT_CREATOR_API}/${id}/export`,
    headers,
    payload: { seed: doSeed },
  })
beforeEach(async () => {
  deny = false
  hold = undefined
  seed.mockReset()
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-create-server-'))
  )
  allowed = path.join(root, 'downloads')
  await mkdir(allowed)
  const policy = await createServerDownloadPathPolicy({
    defaultSaveDir: allowed,
    allowedSaveDirs: [allowed],
  })
  app = await createApp({
    operatorAuth: { operatorToken: token },
    torrentCreator: {
      policy,
      authorizeFile: async (p) => {
        if (hold) await hold
        if (deny && p.endsWith('asset.bin')) throw Error('Access revoked')
        return p
      },
      createTask: seed,
    },
  })
})
afterEach(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true })
})
it('exports valid multi-piece original data only to its owner; seeding is optional and idempotent', async () => {
  const folder = path.join(allowed, 'folder')
  await mkdir(folder)
  await writeFile(path.join(folder, 'asset.bin'), Buffer.alloc(65540, 1))
  expect(
    (
      await app.inject({
        method: 'POST',
        url: TORRENT_CREATOR_API,
        payload: {},
      })
    ).statusCode
  ).toBe(401)
  const res = await start(folder, 'directory')
  expect(res.statusCode).toBe(202)
  const { id } = res.json()
  const ready = await wait(id)
  expect(ready.result).toMatchObject({
    name: 'folder',
    fileCount: 1,
    pieceCount: 3,
  })
  const login = await app.inject({
    method: 'POST',
    url: '/rpc/auth/login',
    payload: { token },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  expect(
    (
      await app.inject({
        url: `${TORRENT_CREATOR_API}/${id}`,
        headers: { cookie },
      })
    ).statusCode
  ).toBe(404)
  const result = await exp(id, false)
  expect(result.statusCode).toBe(200)
  expect(parseTorrent(new Uint8Array(result.rawPayload)).v1?.multiFile).toBe(
    true
  )
  expect(seed).not.toHaveBeenCalled()
  seed.mockResolvedValue({ outcome: 'created' })
  for (const response of [await exp(id, true), await exp(id, true)])
    expect(response.headers[TORRENT_SEED_HEADER]).toBe('submitted')
  expect(seed).toHaveBeenCalledTimes(1)
  expect(seed).toHaveBeenCalledWith(
    expect.objectContaining({
      saveDir: allowed,
      duplicatePolicy: 'use-existing',
      selectedFiles: [0],
    })
  )
  deny = true
  const revoked = await app.inject({
    url: `${TORRENT_CREATOR_API}/${id}`,
    headers,
  })
  expect(revoked.statusCode).toBe(403)
  expect(revoked.body).not.toContain(ready.result.infoHash)
  expect((await exp(id, false)).statusCode).toBe(403)
  await app.inject({
    method: 'DELETE',
    url: `${TORRENT_CREATOR_API}/${id}`,
    headers,
  })
  expect((await exp(id, false)).statusCode).toBe(404)
})
it('still offers the downloadable torrent if original data cannot be admitted for seeding', async () => {
  const file = path.join(allowed, 'asset.bin')
  await writeFile(file, 'abc')
  const { id } = (await start(file)).json()
  expect((await wait(id)).state).toBe('ready')
  seed.mockRejectedValue(new Error('Original data changed'))
  const response = await exp(id, true)
  expect(response.statusCode).toBe(200)
  expect(response.headers[TORRENT_SEED_HEADER]).toBe('failed')
  expect(parseTorrent(new Uint8Array(response.rawPayload)).name).toBe(
    'asset.bin'
  )
})

it('denies an escaping symlink and refuses to hash a folder containing an unreadable NAS member', async () => {
  const outside = path.join(root, 'private.bin')
  await writeFile(outside, 'secret')
  const alias = path.join(allowed, 'alias')
  await symlink(outside, alias)
  for (const source of [alias, outside]) {
    const job = await start(source)
    expect((await wait(job.json().id)).state).toBe('failed')
  }
  await writeFile(path.join(allowed, 'asset.bin'), 'protected')
  deny = true
  const job = await start(allowed, 'directory')
  expect((await wait(job.json().id)).state).toBe('failed')
  expect(seed).not.toHaveBeenCalled()
})

it('holds the single hash slot through cancellation and isolates export work', async () => {
  const file = path.join(allowed, 'asset.bin')
  await writeFile(file, 'valid data')
  let resume!: () => void
  hold = new Promise((resolve) => {
    resume = resolve
  })
  const { id } = (await start(file)).json()
  try {
    expect((await start(file)).statusCode).toBe(429)
    await app.inject({
      method: 'DELETE',
      url: `${TORRENT_CREATOR_API}/${id}`,
      headers,
    })
    expect(
      (await app.inject({ url: `${TORRENT_CREATOR_API}/${id}`, headers }))
        .statusCode
    ).toBe(404)
  } finally {
    hold = undefined
    resume()
  }
  let next: string | undefined
  await expect
    .poll(async () => {
      const r = await start(file)
      if (r.statusCode === 202) next = r.json().id
      return r.statusCode
    })
    .toBe(202)
  if (!next) throw new Error('No replacement job')
  expect((await wait(next)).state).toBe('ready')
  let finish!: () => void
  let entering!: () => void
  const started = new Promise<void>((resolve) => {
    entering = resolve
  })
  seed.mockImplementation(async () => {
    entering()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { outcome: 'created' }
  })
  const first = exp(next, true)
  await started
  try {
    expect((await exp(next, true)).statusCode).toBe(429)
  } finally {
    finish()
  }
  expect((await first).headers[TORRENT_SEED_HEADER]).toBe('submitted')
  expect(seed).toHaveBeenCalledTimes(1)
})

it('does not let abandoned, failed jobs deny a different operator a creation slot', async () => {
  const file = path.join(allowed, 'asset.bin')
  await writeFile(file, 'accessible')
  for (let i = 0; i < 4; i++) {
    const res = await start(path.join(root, 'missing'))
    expect(res.statusCode).toBe(202)
    expect((await wait(res.json().id)).state).toBe('failed')
  }
  const login = await app.inject({
    method: 'POST',
    url: '/rpc/auth/login',
    payload: { token },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const next = await app.inject({
    method: 'POST',
    url: TORRENT_CREATOR_API,
    headers: { cookie },
    payload: { source: { path: file, kind: 'file' }, options: {} },
  })
  expect(next.statusCode).toBe(202)
})
