import {
  type access,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  rm,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerDownloadPathPolicy } from '../download-path-policy'
import { ServerDirectoryService } from '../server-directory-service'
import { createApp } from './app'

const TOKEN = 'directory-test-owner'
const capabilities = [
  { kind: 'query', channel: Queries.ListServerDirectories },
  { kind: 'query', channel: Queries.ValidateServerDirectory },
  { kind: 'command', channel: Commands.CreateServerDirectory },
] as const

describe('authenticated directory RPC', () => {
  let app: FastifyInstance
  let root: string
  let service: ServerDirectoryService
  let cookie: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'motrix-directory-rpc-'))
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: root,
      allowedSaveDirsValue: root,
    })
    service = new ServerDirectoryService(policy)
    app = await createApp({
      operatorAuth: { operatorToken: TOKEN },
      queryHandlers: {
        [Queries.ListServerDirectories]: (request: unknown) =>
          service.list(request),
        [Queries.ValidateServerDirectory]: (request: unknown) =>
          service.validate(request),
      },
      commandHandlers: {
        [Commands.CreateServerDirectory]: (request: unknown) =>
          service.create(request),
      },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    cookie = (login.headers['set-cookie'] as string).split(';')[0]
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  const requestFor = (channel: string, root: string) =>
    channel === Commands.CreateServerDirectory
      ? { parentPath: root, name: 'new' }
      : { path: root }

  it.each(capabilities)(
    'gates $channel against anonymous and cross-origin requests and accepts same-origin sessions',
    async ({ kind, channel }) => {
      const request = {
        method: 'POST' as const,
        url: `/rpc/${kind}/${encodeURIComponent(channel)}`,
        payload: { args: [requestFor(channel, root)] },
      }
      expect((await app.inject(request)).statusCode).toBe(401)
      expect(
        (
          await app.inject({
            ...request,
            headers: {
              cookie,
              host: 'nas.local',
              origin: 'https://attacker.example',
            },
          })
        ).statusCode
      ).toBe(403)
      expect(await readdir(root)).toEqual([])
      const response = await app.inject({
        ...request,
        headers: { cookie, host: 'nas.local', origin: 'http://nas.local' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toContain('no-store')
      expect(response.json()).toMatchObject({
        ok: true,
        value: {
          path:
            channel === Commands.CreateServerDirectory
              ? path.join(root, 'new')
              : root,
        },
      })
    }
  )

  it.each(capabilities)(
    'sanitizes malformed arguments for $channel before dispatch',
    async ({ kind, channel }) => {
      const spy = vi.spyOn(
        service,
        channel === Commands.CreateServerDirectory
          ? 'create'
          : channel === Queries.ListServerDirectories
            ? 'list'
            : 'validate'
      )
      for (const payload of [
        {},
        { args: {} },
        { args: [] },
        { args: [requestFor(channel, root), {}] },
        { args: [requestFor(channel, root)], extra: true },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/rpc/${kind}/${encodeURIComponent(channel)}`,
          headers: { cookie },
          payload,
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
          ok: false,
          error: { code: 'invalidPath' },
        })
      }
      expect(spy).not.toHaveBeenCalled()
    }
  )

  it.each(capabilities)(
    'sanitizes thrown AppErrors and malformed results for $channel',
    async ({ kind, channel }) => {
      const method =
        channel === Commands.CreateServerDirectory
          ? 'create'
          : channel === Queries.ListServerDirectories
            ? 'list'
            : 'validate'
      const spy = vi.spyOn(service, method)
      const request = {
        method: 'POST' as const,
        url: `/rpc/${kind}/${encodeURIComponent(channel)}`,
        headers: { cookie },
        payload: { args: [requestFor(channel, root)] },
      }
      const expected = {
        ok: false,
        error: {
          code:
            channel === Commands.CreateServerDirectory
              ? 'creationOutcomeUnknown'
              : 'unavailable',
        },
      }
      spy.mockRejectedValueOnce(
        new AppError(ErrorCode.TaskCreateFailed, '/private/sensitive-path')
      )
      expect((await app.inject(request)).json()).toEqual(expected)
      spy.mockResolvedValueOnce({
        ok: true,
        value: { private: '/private/sensitive-path' },
      } as never)
      expect((await app.inject(request)).json()).toEqual(expected)
    }
  )

  it('returns strict schema errors and permission failures through the real service without raw details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.ListServerDirectories)}`,
      headers: { cookie },
      payload: { args: [{ path: root, unknown: true }] },
    })
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'invalidPath' },
    })
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: root,
      allowedSaveDirsValue: root,
    })
    service = new ServerDirectoryService(policy, {
      access: vi.fn<typeof access>().mockRejectedValue(
        Object.assign(new Error('/private/permission-details'), {
          code: 'EROFS',
        })
      ),
      mkdir,
      opendir,
    })
    const denied = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.ValidateServerDirectory)}`,
      headers: { cookie },
      payload: { args: [{ path: root }] },
    })
    expect(denied.json()).toEqual({
      ok: false,
      error: { code: 'permissionDenied' },
    })
  })
})

describe('directory preferences RPC boundary', () => {
  const capabilities = [
    {
      kind: 'command',
      channel: Commands.SaveGeneralSettings,
      request: {
        app: {},
        directories: {
          addFavorites: [],
          removeFavorites: [],
          removeRecent: [],
        },
      },
      value: { favorites: [], recent: [] },
    },
    {
      kind: 'query',
      channel: Queries.GetDirectoryPreferences,
      request: {},
      value: { favorites: ['/saved'], recent: ['/stale'] },
    },
    {
      kind: 'query',
      channel: Queries.ListServerDirectoryLocations,
      request: {},
      value: { common: [], favorites: [], recent: [] },
    },
    {
      kind: 'command',
      channel: Commands.MutateDirectoryPreferences,
      request: { action: 'clearRecent' },
      value: { favorites: [], recent: [] },
    },
  ] as const

  it.each(capabilities)(
    'authenticates, checks Origin, prevents caching and sanitizes $channel envelopes',
    async ({ kind, channel, request, value }) => {
      const handler = vi.fn(
        async (_request: unknown): Promise<unknown> => ({ ok: true, value })
      )
      const app = await createApp({
        operatorAuth: { operatorToken: TOKEN },
        commandHandlers: kind === 'command' ? { [channel]: handler } : {},
        queryHandlers: kind === 'query' ? { [channel]: handler } : {},
      })
      try {
        const base = {
          method: 'POST' as const,
          url: `/rpc/${kind}/${encodeURIComponent(channel)}`,
          payload: { args: [request] },
        }
        expect((await app.inject(base)).statusCode).toBe(401)
        expect(handler).not.toHaveBeenCalled()
        const login = await app.inject({
          method: 'POST',
          url: '/rpc/auth/login',
          payload: { token: TOKEN },
        })
        const cookie = (login.headers['set-cookie'] as string).split(';')[0]
        expect(
          (
            await app.inject({
              ...base,
              headers: {
                cookie,
                host: 'nas.local',
                origin: 'https://attacker.example',
              },
            })
          ).statusCode
        ).toBe(403)
        expect(handler).not.toHaveBeenCalled()
        const response = await app.inject({ ...base, headers: { cookie } })
        expect(response.statusCode).toBe(200)
        expect(response.headers['cache-control']).toContain('no-store')
        expect(response.json()).toEqual({ ok: true, value })
        handler.mockClear()
        for (const payload of [
          {},
          { args: [] },
          { args: [request, {}] },
          { args: [request], extra: true },
        ]) {
          expect(
            (await app.inject({ ...base, headers: { cookie }, payload })).json()
          ).toEqual({ ok: false, error: { code: 'invalidPath' } })
        }
        expect(handler).not.toHaveBeenCalled()
        handler.mockRejectedValueOnce(new Error('/private/secret'))
        expect(
          (await app.inject({ ...base, headers: { cookie } })).json()
        ).toEqual({ ok: false, error: { code: 'unavailable' } })
        handler.mockResolvedValueOnce({
          ok: true,
          value,
          secret: 'do not forward',
        })
        expect(
          (await app.inject({ ...base, headers: { cookie } })).json()
        ).toEqual({ ok: false, error: { code: 'unavailable' } })
      } finally {
        await app.close()
      }
    }
  )
})
