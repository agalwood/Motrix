import { describe, expect, it, vi } from 'vitest'
import { NasClientAuthorization } from '../nas/client-authorization'
import { currentNasUser } from '../nas/identity'
import { parseDsmAccount, SynologyAccounts } from './accounts'

const output = (state = 'false', group = '(101) administrators') =>
  `User Name : [alice]\nUser Type : [AUTH_LOCAL]\nUser uid : [1700]\nExpired : [${state}]\n${group}\n`

describe('DSM live account authorization', () => {
  it('requires a complete, unambiguous local active administrator record', () => {
    expect(parseDsmAccount(output(), 'alice')?.userId).toBe('1700')
    for (const value of [
      output('true'),
      output('false', '(100) users'),
      output().replace('AUTH_LOCAL', 'AUTH_DOMAIN'),
      `${output()}Expired : [false]\n`,
      '',
    ])
      expect(parseDsmAccount(value, 'alice')).toBeNull()
    expect(parseDsmAccount(output(), '--enum')).toBeNull()
  })
  it('revalidates bound clients and rejects disable, demotion, account recreation and lookup failure', async () => {
    let state = output()
    let epoch = 'first'
    const accounts = new SynologyAccounts(
      async () => state,
      async () => epoch
    )
    const owner = await accounts.lookup('alice', AbortSignal.timeout(1000))
    expect(owner).not.toBeNull()
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
    for (const disabled of [
      output('true'),
      output('false', '(100) users'),
      '',
    ]) {
      state = disabled
      await expect(authorization.run(client, operation)).rejects.toThrow()
    }
    state = output()
    epoch = 'recreated'
    await expect(authorization.run(client, operation)).rejects.toThrow()
    expect(operation).toHaveBeenCalledTimes(1)
  })
  it('rejects an account database change during the authority lookup', async () => {
    let epoch = 'before'
    const accounts = new SynologyAccounts(
      async () => {
        epoch = 'after'
        return output()
      },
      async () => epoch
    )
    expect(await accounts.lookup('alice', AbortSignal.timeout(1000))).toBeNull()
  })
})
