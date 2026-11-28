import { expect, it } from 'vitest'
import { operatorStatusSchema, supportsClientPairing } from './operator-auth'

it('accepts additive host capabilities while retaining explicit pairing restrictions', () => {
  const status = operatorStatusSchema.parse({
    authed: true,
    mode: 'fnosGateway',
    canLogout: false,
    clientPairing: { cli: true, extension: false, futureProtocol: true },
  })
  expect(supportsClientPairing(status, 'cli')).toBe(true)
  expect(supportsClientPairing(status, 'extension')).toBe(false)
  expect(supportsClientPairing({ ...status, authed: false }, 'cli')).toBe(false)
  expect(
    supportsClientPairing({ ...status, clientPairing: undefined }, 'cli')
  ).toBe(false)
})
