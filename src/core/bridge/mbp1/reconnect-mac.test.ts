import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import {
  buildRT,
  reconnectMacClient,
  reconnectMacServer,
  reconnectTrafficKeys,
} from './reconnect-mac'

const v = loadMbp1Vectors()
const { inputs, expected } = v.reconnect

const mutualKey = hexToBytes(inputs.mutualKey)
const s = hexToBytes(inputs.S)
const c = hexToBytes(inputs.C)

describe('reconnect transcript RT (§8)', () => {
  it('reproduces RT from the reconnect vector inputs', () => {
    const rt = buildRT({
      protocolVersion: 1,
      credentialId: inputs.credentialId,
      browser: inputs.browser,
      verifiedOrigin: inputs.verifiedOrigin,
      instanceId: inputs.instanceId,
    })
    expect(bytesToHex(rt)).toBe(expected.RT)
  })
})

describe('reconnect MACs (§8)', () => {
  const rt = hexToBytes(expected.RT)

  it('reproduces macClient with the "MBP1-R/c" label', () => {
    const mac = reconnectMacClient(mutualKey, s, c, rt)
    expect(bytesToHex(mac)).toBe(expected.macClient)
  })

  it('reproduces macServer with the "MBP1-R/s" label', () => {
    const mac = reconnectMacServer(mutualKey, s, c, rt)
    expect(bytesToHex(mac)).toBe(expected.macServer)
  })

  it('changes macClient when browser is misbound (misbinding property)', () => {
    const tamperedRt = buildRT({
      protocolVersion: 1,
      credentialId: inputs.credentialId,
      browser: 'firefox',
      verifiedOrigin: inputs.verifiedOrigin,
      instanceId: inputs.instanceId,
    })
    const mac = reconnectMacClient(mutualKey, s, c, tamperedRt)
    expect(bytesToHex(mac)).not.toBe(expected.macClient)
  })
})

describe('reconnect traffic keys (§8)', () => {
  it('reproduces kC2S and kS2C', () => {
    const { kC2S, kS2C } = reconnectTrafficKeys(mutualKey, s, c)
    expect(bytesToHex(kC2S)).toBe(expected.trafficC2S)
    expect(bytesToHex(kS2C)).toBe(expected.trafficS2C)
  })
})
