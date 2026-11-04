import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { accountFromSnapshot } from '../../packaging/fnos/cmd/account-authority.mjs'

const key = randomBytes(32)
const today = 20000
function snapshot(password = '$6$fixture-salt$fixture-hash') {
  return {
    passwd: 'alice:x:1000:1001::/home/alice:/usr/sbin/nologin\n',
    group: 'Users:x:1001:\nAdministrators:x:1000:alice\n',
    shadow: `alice:${password}:19000:0:99999:7:::\n`,
  }
}
it('returns only an opaque account revision and does not equate SSH shell with account activation', () => {
  const result = accountFromSnapshot(snapshot(), 1000, key, today * 86400000)
  expect(result).toMatchObject({
    platform: 'fnos',
    userId: '1000',
    username: 'alice',
    administrator: true,
  })
  expect(result.accountRevision).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(result)).not.toContain('fixture-hash')
  expect(accountFromSnapshot(snapshot(), 1000, key, today * 86400000)).toEqual(
    result
  )
})
it.each(['!$6$salt$hash', '!!', '*', '', 'x'])(
  'refuses locked, empty and unsupported password records: %s',
  (password) => {
    expect(
      accountFromSnapshot(snapshot(password), 1000, key, today * 86400000)
    ).toBeNull()
  }
)
it('reflects demotion and detects same-UID credential replacement without exposing password material', () => {
  const first = accountFromSnapshot(snapshot(), 1000, key, today * 86400000)
  const second = accountFromSnapshot(
    snapshot('$6$new-salt$new-hash'),
    1000,
    key,
    today * 86400000
  )
  expect(second.accountRevision).not.toBe(first.accountRevision)
  const demoted = snapshot()
  demoted.group = 'Users:x:1001:\nAdministrators:x:1000:bob\n'
  expect(
    accountFromSnapshot(demoted, 1000, key, today * 86400000).administrator
  ).toBe(false)
})
it('rejects missing, duplicate and expired account records', () => {
  expect(
    accountFromSnapshot(snapshot(), 1001, key, today * 86400000)
  ).toBeNull()
  const duplicate = snapshot()
  duplicate.passwd += duplicate.passwd
  expect(accountFromSnapshot(duplicate, 1000, key, today * 86400000)).toBeNull()
  for (const fields of [
    '0:0:99999:7:::',
    '19000:0:30:7:::',
    '19000:0:99999:7::20000:',
  ]) {
    const expired = snapshot()
    expired.shadow = `alice:$6$salt$hash:${fields}\n`
    expect(accountFromSnapshot(expired, 1000, key, today * 86400000)).toBeNull()
  }
})
it.each([[1000], '1e3', -1, 0xffffffff])(
  'rejects invalid account IDs before processing records: %j',
  (uid) => {
    expect(() => accountFromSnapshot(snapshot(), uid, key)).toThrow(
      'unavailable'
    )
  }
)
