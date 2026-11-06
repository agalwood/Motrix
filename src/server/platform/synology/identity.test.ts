import type { FastifyRequest } from 'fastify'
import { expect, it, vi } from 'vitest'
import { SynologyAccounts } from './accounts'
import { DsmCommandError } from './commands'
import { synologyGateway } from './identity'

function request(headers: Record<string, string>, peer?: string) {
  return {
    headers,
    server: { server: { address: () => '/var/test.sock' } },
    raw: { socket: { remoteAddress: peer } },
  } as unknown as FastifyRequest
}
const headers = {
  cookie: 'id=private-cookie',
  'x-motrix-dsm-remote-addr': '192.0.2.2',
  'x-motrix-dsm-server-addr': '192.0.2.1',
  'x-motrix-dsm-server-port': '5001',
  'x-motrix-dsm-scheme': 'https',
}
it('uses live DSM APIs only through the trusted Unix listener and ignores identity headers', async () => {
  const accounts = new SynologyAccounts()
  const authenticate = vi.spyOn(accounts, 'authenticate').mockResolvedValue({
    platform: 'synology',
    userId: '1700',
    username: 'alice',
    administrator: true,
  })
  const adapter = synologyGateway('/var/test.sock', accounts)
  expect(await adapter.authenticate(request(headers))).toMatchObject({
    username: 'alice',
    administrator: true,
  })
  expect(authenticate).toHaveBeenCalledWith(
    expect.objectContaining({
      cookie: 'id=private-cookie',
      remoteAddress: '192.0.2.2',
      scheme: 'https',
      serverPort: 5001,
    }),
    expect.any(AbortSignal)
  )
  authenticate.mockClear()
  for (const req of [
    request(headers, '127.0.0.1'),
    request({ 'x-trim-userid': '1700', 'x-trim-isadmin': 'true' }),
    request({ ...headers, 'x-motrix-dsm-remote-addr': 'spoofed' }),
  ])
    expect(await adapter.authenticate(req)).toBeUndefined()
  expect(authenticate).not.toHaveBeenCalled()
})
it('fails closed and returns only bounded diagnostics, never session or account data', async () => {
  const accounts = new SynologyAccounts()
  const authenticate = vi
    .spyOn(accounts, 'authenticate')
    .mockResolvedValue(null)
  const adapter = synologyGateway('/var/test.sock', accounts)
  const req = request(headers)
  expect(await adapter.authenticate(req)).toBeUndefined()
  authenticate.mockRejectedValue(
    new DsmCommandError({ code: 'EACCES', stderr: 'private-output' })
  )
  expect(await adapter.authenticate(req)).toBeUndefined()
  expect(adapter.diagnostic?.(req)).toEqual({
    stage: 'account',
    code: 'commandFailed',
    failure: 'accessDenied',
  })
  expect(JSON.stringify(adapter.diagnostic?.(req))).not.toContain('private')
})
