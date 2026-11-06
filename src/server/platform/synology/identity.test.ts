import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { SynologyAccounts } from './accounts'
import { synologyGateway } from './identity'

const account =
  'User Name : [alice]\nUser Type : [AUTH_LOCAL]\nUser uid : [1700]\nExpired : [false]\n(101) administrators\n'
function request(headers: Record<string, string>, peer?: string) {
  return {
    headers,
    server: { server: { address: () => '/var/test.sock' } },
    raw: { socket: { remoteAddress: peer } },
  } as unknown as FastifyRequest
}
describe('DSM session boundary', () => {
  it('requires a DSM session result and current administrator state, ignoring identity headers', async () => {
    const command = vi.fn(async () => 'alice')
    const accounts = new SynologyAccounts(
      async () => account,
      async () => 'generation'
    )
    const adapter = synologyGateway('/var/test.sock', accounts, command)
    const headers = {
      cookie: 'id=synthetic',
      'x-motrix-dsm-remote-addr': '192.0.2.2',
      'x-motrix-dsm-server-addr': '192.0.2.1',
      'x-motrix-dsm-server-port': '5001',
      'x-motrix-dsm-scheme': 'https',
    }
    expect(await adapter.authenticate(request(headers))).toMatchObject({
      platform: 'synology',
      username: 'alice',
      administrator: true,
    })
    expect(command.mock.calls[0]).toEqual([
      '/usr/syno/synoman/webman/modules/authenticate.cgi',
      [],
      expect.objectContaining({
        HTTP_COOKIE: 'id=synthetic',
        REMOTE_ADDR: '192.0.2.2',
        SERVER_PORT: '5001',
        HTTPS: 'on',
        GATEWAY_INTERFACE: 'CGI/1.1',
      }),
    ])
    command.mockClear()
    for (const req of [
      request(headers, '127.0.0.1'),
      request({
        'x-trim-isadmin': 'true',
        'x-trim-userid': '1700',
        'x-trim-username': 'alice',
      }),
      request({ ...headers, 'x-motrix-dsm-remote-addr': 'spoofed' }),
    ])
      expect(await adapter.authenticate(req)).toBeUndefined()
    expect(command).not.toHaveBeenCalled()
  })
  it('never grants access after empty, ambiguous or failed authentication', async () => {
    const accounts = new SynologyAccounts(
      async () => account,
      async () => 'generation'
    )
    const headers = {
      cookie: 'id=synthetic',
      'x-motrix-dsm-remote-addr': '127.0.0.1',
      'x-motrix-dsm-server-addr': '127.0.0.1',
      'x-motrix-dsm-server-port': '5001',
      'x-motrix-dsm-scheme': 'https',
    }
    for (const output of ['', 'alice\nbob', 'root'])
      expect(
        await synologyGateway(
          '/var/test.sock',
          accounts,
          async () => output
        ).authenticate(request(headers))
      ).toBeUndefined()
    expect(
      await synologyGateway('/var/test.sock', accounts, async () => {
        throw new Error('unavailable')
      }).authenticate(request(headers))
    ).toBeUndefined()
  })
})

it('distinguishes a session helper failure from account lookup failure without returning private data', async () => {
  const { DsmCommandError } = await import('./commands')
  const headers = {
    cookie: 'id=private-cookie',
    'x-motrix-dsm-remote-addr': '127.0.0.1',
    'x-motrix-dsm-server-addr': '127.0.0.1',
    'x-motrix-dsm-server-port': '5001',
    'x-motrix-dsm-scheme': 'https',
  }
  const accounts = new SynologyAccounts(
    async () => {
      throw new DsmCommandError({ code: 'EACCES', stderr: 'private-output' })
    },
    async () => 'generation'
  )
  const session = synologyGateway('/var/test.sock', accounts, async () => {
    throw new DsmCommandError({ code: 5, stderr: 'private-output' })
  })
  const req = request(headers)
  expect(await session.authenticate(req)).toBeUndefined()
  expect(session.diagnostic?.(req)).toEqual({
    stage: 'session',
    code: 'commandFailed',
    failure: 'exit',
    exitCode: 5,
  })
  const accountAdapter = synologyGateway(
    '/var/test.sock',
    accounts,
    async () => 'alice'
  )
  expect(await accountAdapter.authenticate(req)).toBeUndefined()
  expect(accountAdapter.diagnostic?.(req)).toEqual({
    stage: 'account',
    code: 'commandFailed',
    failure: 'accessDenied',
  })
  expect(JSON.stringify(accountAdapter.diagnostic?.(req))).not.toContain(
    'private'
  )
  expect(JSON.stringify(accountAdapter.diagnostic?.(req))).not.toContain(
    'alice'
  )
})
