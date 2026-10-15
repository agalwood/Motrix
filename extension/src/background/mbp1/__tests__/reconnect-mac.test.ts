import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import {
  reconnectMacs,
  reconnectTrafficKeys,
  reconnectTranscript,
} from '@/background/mbp1/reconnect-mac'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

describe('reconnect transcript, MACs, and traffic keys (§8)', () => {
  const { inputs, expected } = MBP1_VECTORS.reconnect

  it('matches the reconnect vector', () => {
    const RT = reconnectTranscript({
      protocolVersion: 1,
      credentialId: inputs.credentialId ?? '',
      browser: inputs.browser ?? '',
      verifiedOrigin: inputs.verifiedOrigin ?? '',
      instanceId: inputs.instanceId ?? '',
    })
    expect(hex(RT)).toBe(expected.RT)

    const macs = reconnectMacs(
      fromHex(inputs.mutualKey ?? ''),
      fromHex(inputs.S ?? ''),
      fromHex(inputs.C ?? ''),
      RT
    )
    expect(hex(macs.client)).toBe(expected.macClient)
    expect(hex(macs.server)).toBe(expected.macServer)

    const keys = reconnectTrafficKeys(
      fromHex(inputs.mutualKey ?? ''),
      fromHex(inputs.S ?? ''),
      fromHex(inputs.C ?? '')
    )
    expect(hex(keys.c2s)).toBe(expected.trafficC2S)
    expect(hex(keys.s2c)).toBe(expected.trafficS2C)
  })

  // Misbinding property (§8): `browser` is bound into RT from the stored
  // credential principal, so an in-path attacker (or a bug) that swaps it
  // must desynchronize the MAC rather than let a different-browser
  // credential silently authenticate.
  it('changes macClient when browser is misbound', () => {
    const RT = reconnectTranscript({
      protocolVersion: 1,
      credentialId: inputs.credentialId ?? '',
      browser: inputs.browser ?? '',
      verifiedOrigin: inputs.verifiedOrigin ?? '',
      instanceId: inputs.instanceId ?? '',
    })
    const misboundRT = reconnectTranscript({
      protocolVersion: 1,
      credentialId: inputs.credentialId ?? '',
      browser: 'firefox',
      verifiedOrigin: inputs.verifiedOrigin ?? '',
      instanceId: inputs.instanceId ?? '',
    })
    expect(hex(misboundRT)).not.toBe(hex(RT))

    const mutualKey = fromHex(inputs.mutualKey ?? '')
    const S = fromHex(inputs.S ?? '')
    const C = fromHex(inputs.C ?? '')
    const macs = reconnectMacs(mutualKey, S, C, RT)
    const misboundMacs = reconnectMacs(mutualKey, S, C, misboundRT)
    expect(hex(misboundMacs.client)).not.toBe(hex(macs.client))
    // Anchor the honest side to the vector so this test cannot pass by
    // both sides being independently wrong in the same way.
    expect(hex(macs.client)).toBe(expected.macClient)
  })
})
