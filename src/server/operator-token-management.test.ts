import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './http/app'
import { OperatorAdminExitCode, runOperatorAdmin } from './operator-admin'
import {
  operatorTokenAuthorization,
  persistOperatorToken,
  provisionOperatorToken,
} from './operator-token'

describe('operator token management', () => {
  let dir: string
  let app: FastifyInstance
  let token: string
  let path: string
  let persist: ReturnType<typeof vi.fn<(next: string) => Promise<void>>>
  let now: number
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-token-change-'))
    const provisioned = await provisionOperatorToken({ dataDir: dir, env: {} })
    token = provisioned.token
    path = provisioned.path!
    persist = vi.fn((next: string) => persistOperatorToken(path, next))
    now = 1000
    app = await createApp({
      operatorAuth: {
        operatorToken: token,
        tokenSource: 'file',
        persistToken: persist,
        now: () => now,
      },
    })
  })
  afterEach(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function login(value = token) {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: value },
    })
    expect(res.statusCode).toBe(200)
    return String(res.headers['set-cookie']).split(';')[0]!
  }
  const status = (cookie: string) =>
    app.inject({ url: '/rpc/auth/status', headers: { cookie } })
  const change = (
    newToken: string,
    currentToken = token,
    headers: Record<string, string> = {
      authorization: operatorTokenAuthorization(token),
    }
  ) =>
    app.inject({
      method: 'POST',
      url: '/rpc/auth/token',
      headers,
      payload: { currentToken, newToken },
    })

  it('accepts a weak token, persists it, preserves the current cookie and revokes others', async () => {
    const current = await login()
    const other = await login()
    const res = await change('1', token, {
      cookie: current,
      host: 'motrix.test',
      origin: 'http://motrix.test',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(
      (await provisionOperatorToken({ dataDir: dir, env: {} })).token
    ).toBe('1')
    expect((await status(current)).json().authed).toBe(true)
    expect((await status(other)).json().authed).toBe(false)
    expect(
      (
        await app.inject({
          url: '/rpc/auth/status',
          headers: { authorization: operatorTokenAuthorization(token) },
        })
      ).json().authed
    ).toBe(false)
    await login('1')
  })

  it('rejects unauthenticated, cross-origin, and stale-credential changes without writing', async () => {
    expect((await change('1', token, {})).statusCode).toBe(401)
    const cookie = await login()
    expect(
      (await change('1', token, { cookie, origin: 'http://evil.example' }))
        .statusCode
    ).toBe(403)
    expect((await change('1', token, { cookie })).statusCode).toBe(403)
    expect(
      (await change('1', token, { cookie, authorization: 'Bearer invalid' }))
        .statusCode
    ).toBe(403)
    expect(
      (
        await change('1', token, {
          cookie,
          host: 'motrix.test',
          origin: 'https://motrix.test',
          authorization: 'Bearer invalid',
        })
      ).statusCode
    ).toBe(403)
    expect((await change('1', 'wrong')).json()).toEqual({
      ok: false,
      reason: 'incorrectToken',
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it('retains the previous credential and sessions if persistence fails', async () => {
    const cookie = await login()
    persist.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await change('1')).json()).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(await readFile(path, 'utf8')).toBe(token)
    expect((await status(cookie)).json().authed).toBe(true)
    await login()
  })

  it('serializes concurrent changes and rejects the stale second request', async () => {
    let release!: () => void
    persist.mockImplementationOnce(async (next) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await persistOperatorToken(path, next)
    })
    const first = change('first').then((response) => response)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const second = change('second').then((response) => response)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    expect((await first).statusCode).toBe(200)
    expect((await second).statusCode).toBe(403)
    expect(await readFile(path, 'utf8')).toBe('first')
    expect(persist).toHaveBeenCalledOnce()
  })

  it('throttles direct HTTP credential guesses and recovers after the window', async () => {
    for (let i = 0; i < 20; i++)
      await app.inject({
        url: '/rpc/auth/status',
        headers: { authorization: 'Bearer wrong' },
      })
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/rpc/auth/login',
          payload: { token },
        })
      ).statusCode
    ).toBe(429)
    now += 60_001
    await login()
  })

  it('keeps environment-managed credentials read-only', async () => {
    await app.close()
    app = await createApp({
      operatorAuth: {
        operatorToken: token,
        tokenSource: 'env',
        persistToken: persist,
      },
    })
    expect((await change('1')).json()).toEqual({ ok: false, reason: 'managed' })
    expect(persist).not.toHaveBeenCalled()
  })

  it('changes via CLI stdin, then uses a Unicode token to rotate again without exposing credentials', async () => {
    const output: string[] = []
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await app.inject({
          method: 'POST',
          url: new URL(String(input)).pathname,
          headers: Object.fromEntries(new Headers(init?.headers)),
          payload: String(init?.body),
        })
        return new Response(response.body, { status: response.statusCode })
      }
    )
    let next = '中文令牌'
    const options = {
      env: { MOTRIX_DATA_DIR: dir },
      fetch: fetchMock as typeof fetch,
      readTokenStdin: async () => next,
      writeStdout: (line: string) => output.push(line),
      writeStderr: (line: string) => output.push(line),
    }
    expect(
      await runOperatorAdmin(['token', 'set', '--stdin', '--json'], options)
    ).toBe(OperatorAdminExitCode.Success)
    await login(next)
    next = '2'
    expect(await runOperatorAdmin(['token', 'set', '--stdin'], options)).toBe(
      OperatorAdminExitCode.Success
    )
    await login(next)
    expect(output.join('\n')).toContain('easy to guess')
    expect(output.join('\n')).not.toContain(token)
    expect(output.join('\n')).not.toContain('中文令牌')
  })

  it('rejects mismatched confirmation and environment configuration before attempting a mutation', async () => {
    const fetchMock = vi.fn()
    const readSecret = vi
      .fn()
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('2')
    const options = {
      env: { MOTRIX_DATA_DIR: dir },
      fetch: fetchMock,
      readSecret,
      writeStderr: vi.fn(),
    }
    expect(await runOperatorAdmin(['token', 'set'], options)).toBe(
      OperatorAdminExitCode.Usage
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      await runOperatorAdmin(['token', 'set'], {
        ...options,
        env: { MOTRIX_OPERATOR_TOKEN: token },
      })
    ).toBe(OperatorAdminExitCode.Credential)
    expect(readSecret).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      status: 401,
      body: { error: 'unauthorized' },
      code: 'token.incorrectToken',
      exit: OperatorAdminExitCode.Credential,
    },
    {
      status: 429,
      body: { error: 'too many attempts' },
      code: 'token.rateLimited',
      exit: OperatorAdminExitCode.Unavailable,
    },
    {
      status: 503,
      body: { ok: false, reason: 'unavailable' },
      code: 'token.unavailable',
      exit: OperatorAdminExitCode.Server,
    },
  ])(
    'reports JSON warnings and failures without credentials for HTTP $status',
    async ({ status, body, code, exit }) => {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(
        await runOperatorAdmin(['token', 'set', '--stdin', '--json'], {
          env: { MOTRIX_DATA_DIR: dir },
          readTokenStdin: async () => '1',
          fetch: vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify(body), { status })),
          writeStdout: (line) => stdout.push(line),
          writeStderr: (line) => stderr.push(line),
        })
      ).toBe(exit)
      expect(stdout).toEqual([])
      expect(stderr.map((line) => JSON.parse(line))).toMatchObject([
        { warning: { code: 'token.weak' } },
        { ok: false, error: { code } },
      ])
      expect(stderr.join('\n')).not.toContain(token)
    }
  )

  it('reports local input errors in JSON without calling the server', async () => {
    const stderr: string[] = []
    const fetchMock = vi.fn()
    expect(
      await runOperatorAdmin(['token', 'set', '--stdin', '--json'], {
        env: { MOTRIX_DATA_DIR: dir },
        readTokenStdin: async () => '',
        fetch: fetchMock,
        writeStderr: (line) => stderr.push(line),
      })
    ).toBe(OperatorAdminExitCode.Usage)
    expect(stderr.map((line) => JSON.parse(line))).toMatchObject([
      { ok: false, error: { code: 'token.invalid' } },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
