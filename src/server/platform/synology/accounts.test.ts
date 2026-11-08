import { describe, expect, it, vi } from 'vitest'
import { NasClientAuthorization } from '../nas/client-authorization'
import { currentNasUser } from '../nas/identity'
import { SynologyAccounts } from './accounts'
import type { DsmApi } from './api'

const context = {
  cookie: 'id=synthetic',
  remoteAddress: '127.0.0.1',
  serverAddress: '127.0.0.1',
  serverPort: 5001,
  scheme: 'https' as const,
}
function fixture() {
  const state = {
    expired: 'normal',
    admin: true,
    epoch: 'first',
    username: 'alice',
    uid: 1700,
    session: true,
    filePath: '/volume1/motrix/file',
  }
  const api: DsmApi = vi.fn(async (_context, request, token) => {
    if (!state.session) return { success: false, error: { code: 119 } }
    if (request.kind === 'bootstrap')
      return { success: true, SynoToken: 'synthetic-token' }
    expect(token).toBe('synthetic-token')
    if (request.kind === 'session')
      return { success: true, data: { username: state.username } }
    if (request.kind === 'account')
      return {
        success: true,
        data: {
          users: [
            { name: request.username, uid: state.uid, expired: state.expired },
          ],
        },
      }
    return {
      success: true,
      data: {
        files: [
          {
            path: request.path,
            isdir: false,
            additional: {
              real_path: state.filePath,
              perm: {
                acl: {
                  read: true,
                  write: true,
                  append: true,
                  exec: true,
                  del: true,
                },
              },
            },
          },
        ],
      },
    }
  })
  const accounts = new SynologyAccounts(
    api,
    async () => state.epoch,
    async () => ({ uid: state.uid, administrator: state.admin })
  )
  return { state, api, accounts }
}
describe('DSM live account authorization', () => {
  it('requires live session, local active account and POSIX administrator membership', async () => {
    const { state, accounts } = fixture()
    const signal = AbortSignal.timeout(1000)
    expect(await accounts.lookup('alice', signal)).toBeNull()
    expect(await accounts.authenticate(context, signal)).toMatchObject({
      username: 'alice',
      userId: '1700',
      administrator: true,
    })
    for (const expired of ['now', '', 'false', '2030-01-01']) {
      state.expired = expired
      expect(await accounts.authenticate(context, signal)).toBeNull()
    }
    state.expired = 'normal'
    state.admin = false
    expect(await accounts.authenticate(context, signal)).toBeNull()
  })
  it('revalidates paired credentials and rejects disable, demotion, expiry, UID reuse and missing context', async () => {
    const { state, accounts } = fixture()
    const signal = AbortSignal.timeout(1000)
    const owner = await accounts.authenticate(context, signal)
    const authorization = new NasClientAuthorization(
      { ownerOf: () => owner ?? undefined },
      accounts
    )
    const client = {
      identity: { kind: 'cli' as const, id: 'test', name: 'test' },
      credential: { kind: 'paired-cli' as const, fingerprint: 'synthetic' },
    }
    const operation = vi.fn(async () => currentNasUser()?.username)
    expect(await authorization.run(client, operation)).toBe('alice')
    state.expired = 'now'
    await expect(authorization.run(client, operation)).rejects.toThrow()
    state.expired = 'normal'
    // Failed authority clears the in-memory context until this account returns.
    await expect(authorization.run(client, operation)).rejects.toThrow()
    await accounts.authenticate(context, signal)
    state.admin = false
    await expect(authorization.run(client, operation)).rejects.toThrow()
    state.admin = true
    await accounts.authenticate(context, signal)
    state.session = false
    await expect(authorization.run(client, operation)).rejects.toThrow()
    state.session = true
    await accounts.authenticate(context, signal)
    state.epoch = 'recreated'
    await expect(authorization.run(client, operation)).rejects.toThrow()
    state.epoch = 'first'
    state.uid = 1800
    await expect(authorization.run(client, operation)).rejects.toThrow()
    expect(operation).toHaveBeenCalledTimes(1)
  })
  it('does not authorize an old owner with another current session account', async () => {
    const { state, accounts } = fixture()
    await accounts.authenticate(context, AbortSignal.timeout(1000))
    state.username = 'bob'
    expect(await accounts.lookup('alice', AbortSignal.timeout(1000))).toBeNull()
  })
  it('rechecks DSM instead of expiring a valid account after browser inactivity', async () => {
    const { state, api, accounts } = fixture()
    const identity = await accounts.authenticate(
      context,
      AbortSignal.timeout(1000)
    )
    expect(JSON.stringify(identity)).not.toContain('synthetic')
    const before = vi.mocked(api).mock.calls.length
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 8 * 60 * 60_000)
    try {
      expect(
        await accounts.lookup('alice', AbortSignal.timeout(1000))
      ).toMatchObject({ userId: '1700' })
      expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(before)
      state.session = false
      expect(
        await accounts.lookup('alice', AbortSignal.timeout(1000))
      ).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })
  it('keeps concurrent client validation valid when the same browser renews its context', async () => {
    const { api, accounts } = fixture()
    await accounts.authenticate(context, AbortSignal.timeout(1000))
    const original = vi.mocked(api).getMockImplementation()
    if (!original) throw new Error('Fixture API missing')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(api).mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
    const pending = accounts.lookup('alice', AbortSignal.timeout(1000))
    await accounts.authenticate(context, AbortSignal.timeout(1000))
    release()
    expect(await pending).toMatchObject({ username: 'alice' })
  })
  it('requires exact File Station path mapping and complete permission metadata', async () => {
    const { state, accounts } = fixture()
    const identity = await accounts.authenticate(
      context,
      AbortSignal.timeout(1000)
    )
    if (!identity) throw new Error('Fixture identity missing')
    expect(
      await accounts.inspectFile(
        identity,
        '/volume1/motrix/file',
        AbortSignal.timeout(1000)
      )
    ).not.toBeNull()
    state.filePath = '/volume2/motrix/file'
    expect(
      await accounts.inspectFile(
        identity,
        '/volume1/motrix/file',
        AbortSignal.timeout(1000)
      )
    ).toBeNull()
    expect(
      await accounts.inspectFile(
        identity,
        '/etc/shadow',
        AbortSignal.timeout(1000)
      )
    ).toBeNull()
  })
  it('rejects account generation changes during an authority lookup', async () => {
    const { api } = fixture()
    let epoch = 0
    const accounts = new SynologyAccounts(
      api,
      async () => String(epoch++),
      async () => ({ uid: 1700, administrator: true })
    )
    expect(
      await accounts.authenticate(context, AbortSignal.timeout(1000))
    ).toBeNull()
  })
})
