// Typed loader for the normative MBP1 cross-implementation test vectors in
// docs/bridge-pairing-protocol-vectors.json (spec docs/bridge-pairing-protocol.md
// §13). Every mbp1 crypto test (canonical encoding, SPAKE2, transcript,
// envelope, ticket verification) imports `loadMbp1Vectors` from this module —
// its path and exported names are fixed across the whole mbp1 test suite.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

/** One SPAKE2 vector. Later vectors may omit fields identical to vector 0
 * (see `spake2[1].inputs.note` in the fixture), so the nested groups are
 * loosely typed hex-string maps rather than fully required shapes. */
interface Spake2Vector {
  name: string
  inputs: Record<string, string>
  intermediate: Record<string, string>
  expected: Record<string, string>
}

/** A single negative-vector entry under a group's `mustReject` array. Shape
 * varies by case (e.g. `bindingPub` may be a single hex string or an array
 * of them), so only the fields every case carries are required. */
interface MustRejectCase {
  case: string
  reason: string
  [key: string]: unknown
}

export interface Mbp1Vectors {
  description: string
  generator: {
    library: string
    coreValidation: string
  }
  spake2: Spake2Vector[]
  scryptW: {
    inputs: {
      codeNormalized: string
      pairNonce: string
      params: { N: number; r: number; p: number; dkLen: number }
    }
    expected: {
      scryptOutput: string
      w: string
    }
  }
  reconnect: {
    inputs: {
      mutualKey: string
      credentialId: string
      browser: string
      verifiedOrigin: string
      instanceId: string
      S: string
      C: string
    }
    expected: {
      RT: string
      macClient: string
      macServer: string
      trafficC2S: string
      trafficS2C: string
    }
  }
  nmTicket: {
    inputs: {
      v: number
      localToken: string
      serverGeneration: string
      browser: string
      callerId: string
      exp: number
      bindingPub: string
    }
    expected: {
      ticketKey: string
      canonical: string
      mac: string
      ticketDigest: string
    }
    mustReject: MustRejectCase[]
    note: string
  }
  envelope: {
    inputs: {
      keyC2S: string
      keyS2C: string
      aad: string
      plaintext0: string
      plaintext1: string
    }
    expected: {
      frameC2S_seq0: string
      frameS2C_seq0: string
      frameC2S_seq1: string
    }
    mustReject: MustRejectCase[]
  }
}

const VECTORS_PATH = resolve(
  __dirname,
  '../../../../../docs/bridge-pairing-protocol-vectors.json'
)

export function loadMbp1Vectors(): Mbp1Vectors {
  const raw = readFileSync(VECTORS_PATH, 'utf-8')
  return JSON.parse(raw) as Mbp1Vectors
}
