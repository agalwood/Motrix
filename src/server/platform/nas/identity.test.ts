import { expect, it } from 'vitest'
import {
  currentNasApprover,
  currentNasUser,
  type NasIdentity,
  runAsNasGatewayUser,
  runAsNasUser,
} from './identity'

const alice: NasIdentity = {
  platform: 'fnos',
  userId: '1000',
  username: 'alice',
  administrator: true,
}
const bob: NasIdentity = {
  platform: 'synology',
  userId: 'domain/user',
  username: 'bob',
  administrator: false,
}

it('keeps overlapping and nested NAS requests isolated through awaits', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runAsNasUser(alice, async () => {
    await waiting
    expect(currentNasUser()).toEqual(alice)
    await runAsNasUser(bob, async () => {
      await Promise.resolve()
      expect(currentNasUser()).toEqual(bob)
    })
    expect(currentNasUser()).toEqual(alice)
  })
  await runAsNasUser(bob, async () => {
    expect(currentNasUser()).toEqual(bob)
    release()
    await first
    expect(currentNasUser()).toEqual(bob)
  })
  expect(currentNasUser()).toBeUndefined()
})

it('does not retain caller mutations or a failed request identity', () => {
  const input = { ...alice }
  expect(() =>
    runAsNasUser(input, () => {
      input.userId = '2000'
      expect(currentNasUser()?.userId).toBe('1000')
      throw new Error('request failed')
    })
  ).toThrow('request failed')
  expect(currentNasUser()).toBeUndefined()
})

it.each(['', 'name\0other', 'name\nother'])(
  'rejects invalid platform account identifiers before dispatch: %j',
  (userId) => {
    let called = false
    expect(() =>
      runAsNasUser({ ...alice, userId }, () => {
        called = true
      })
    ).toThrow()
    expect(called).toBe(false)
    expect(currentNasUser()).toBeUndefined()
  }
)

it('does not promote an internal or paired-client identity to a gateway approver', async () => {
  await runAsNasGatewayUser(alice, async () => {
    expect(currentNasApprover()).toEqual(alice)
    await runAsNasUser(alice, async () => {
      await Promise.resolve()
      expect(currentNasUser()).toEqual(alice)
      expect(currentNasApprover()).toBeUndefined()
    })
    expect(currentNasApprover()).toEqual(alice)
  })
  expect(currentNasApprover()).toBeUndefined()
})
