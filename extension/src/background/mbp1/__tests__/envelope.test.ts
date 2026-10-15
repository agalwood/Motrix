import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { encU64BE } from '@/background/mbp1/canonical'
import { EnvelopeCodec, EnvelopeViolation } from '@/background/mbp1/envelope'

const H = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('MBP1 AEAD envelope (§10)', () => {
  const { inputs, expected, mustReject } = MBP1_VECTORS.envelope

  it('produces the expected c2s seq0 frame', async () => {
    const client = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'client'
    )
    const frame = await client.seal(H(inputs.plaintext0))
    expect(hex(frame)).toBe(expected.frameC2S_seq0)
  })

  it('produces the expected s2c seq0 frame', async () => {
    const server = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'server'
    )
    const frame = await server.seal(H(inputs.plaintext1))
    expect(hex(frame)).toBe(expected.frameS2C_seq0)
  })

  it('produces the expected c2s seq1 frame after sealing seq0', async () => {
    const client = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'client'
    )
    await client.seal(H(inputs.plaintext0)) // consumes seq 0
    const frame = await client.seal(H(inputs.plaintext1)) // seq 1
    expect(hex(frame)).toBe(expected.frameC2S_seq1)
  })

  it('round-trips all three vector frames through open()', async () => {
    const client = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'client'
    )
    const server = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'server'
    )

    const f0 = await client.seal(H(inputs.plaintext0))
    expect(hex(f0)).toBe(expected.frameC2S_seq0)
    expect(hex(await server.open(f0))).toBe(inputs.plaintext0)

    const g0 = await server.seal(H(inputs.plaintext1))
    expect(hex(g0)).toBe(expected.frameS2C_seq0)
    expect(hex(await client.open(g0))).toBe(inputs.plaintext1)

    const f1 = await client.seal(H(inputs.plaintext1))
    expect(hex(f1)).toBe(expected.frameC2S_seq1)
    expect(hex(await server.open(f1))).toBe(inputs.plaintext1)
  })

  it('server opens c2s seq0 then rejects a replay (strict seq)', async () => {
    const server = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'server'
    )
    const pt = await server.open(H(expected.frameC2S_seq0))
    expect(hex(pt)).toBe(inputs.plaintext0)
    await expect(server.open(H(expected.frameC2S_seq0))).rejects.toMatchObject({
      reason: 'sequenceMismatch',
    })
  })

  // The four vector mustReject cases, each asserting the specific violation
  // reason rather than merely that something threw.
  describe('mustReject vector cases', () => {
    it('sanity: the vector still carries exactly these four cases', () => {
      expect(mustReject.map((c) => c.reason)).toEqual([
        'gcm auth failure',
        'gcm auth failure (nonce direction tag); catches dirTag-ignoring implementations',
        'gcm auth failure',
        'strict sequence check',
      ])
    })

    it('rejects "last ciphertext byte of frameC2S_seq0 XOR 0x01" (tampered ciphertext)', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      const tampered = H(expected.frameC2S_seq0)
      tampered[tampered.length - 1] ^= 0x01
      await expect(server.open(tampered)).rejects.toMatchObject({
        reason: 'gcmAuthFailure',
      })
    })

    it('rejects "frameC2S_seq0 decrypted with the SAME key but dirTag 2"', async () => {
      // EnvelopeCodec never lets a caller pick dirTag directly, so this
      // reaches the same scenario through the public API: a 'client' codec
      // whose keyS2C slot is *also* keyC2S opens its inbound (s2c, dirTag=2)
      // direction with the c2s key — same key, flipped dirTag, exactly the
      // vector's case.
      const sameKeyFlippedDirTag = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyC2S),
        'client'
      )
      await expect(
        sameKeyFlippedDirTag.open(H(expected.frameC2S_seq0))
      ).rejects.toMatchObject({ reason: 'gcmAuthFailure' })
    })

    it('rejects "frameC2S_seq0 decrypted with the s2c key" (wrong direction key)', async () => {
      // A 'server' codec opens c2s (dirTag=1, correct) but its keyC2S slot
      // holds keyS2C instead — same dirTag, wrong key.
      const wrongKey = await EnvelopeCodec.create(
        H(inputs.keyS2C),
        H(inputs.keyC2S),
        'server'
      )
      await expect(
        wrongKey.open(H(expected.frameC2S_seq0))
      ).rejects.toMatchObject({ reason: 'gcmAuthFailure' })
    })

    it('rejects "frameC2S_seq1 presented when expected seq is 0" (strict sequence check)', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      await expect(
        server.open(H(expected.frameC2S_seq1))
      ).rejects.toMatchObject({ reason: 'sequenceMismatch' })
    })
  })

  describe('1 MiB plaintext cap, enforced on both send and receive', () => {
    it('seal() accepts exactly 1 MiB', async () => {
      const client = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'client'
      )
      const frame = await client.seal(new Uint8Array(1024 * 1024))
      expect(frame.length).toBe(8 + 1024 * 1024 + 16)
    })

    it('seal() rejects 1 MiB + 1 byte', async () => {
      const client = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'client'
      )
      await expect(
        client.seal(new Uint8Array(1024 * 1024 + 1))
      ).rejects.toMatchObject({ reason: 'oversizePlaintext' })
    })

    it('open() accepts a real, authentic frame at exactly 1 MiB', async () => {
      const client = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'client'
      )
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      const CAP = 1024 * 1024
      // Non-constant content, so a corrupted round trip cannot pass by
      // accident. Built from 16 copies of one 64 KiB random block:
      // getRandomValues caps at 65536 bytes per call, and a per-byte fill loop
      // over 1 MiB would dominate this file's runtime.
      const block = crypto.getRandomValues(new Uint8Array(64 * 1024))
      const plaintext = new Uint8Array(CAP)
      for (let offset = 0; offset < CAP; offset += block.length) {
        plaintext.set(block, offset)
      }

      const frame = await client.seal(plaintext)
      expect(frame.length).toBe(8 + CAP + 16)
      // This is the only test that runs open()'s
      // `ciphertext.length - GCM_TAG_BYTES` arithmetic against a real frame.
      // Drop that subtraction and open() computes 1_048_592 against a
      // 1_048_576 cap, rejecting every legal maximum-size frame — while every
      // other test in this file stays green, because they either exercise
      // seal()'s own arithmetic or open()'s rejection path, where a 16-byte
      // overcount changes no outcome.
      const opened = await server.open(frame)
      expect(opened.length).toBe(CAP)
      expect(hex(opened.subarray(CAP - 16))).toBe(hex(plaintext.subarray(-16)))
      expect(Buffer.compare(Buffer.from(opened), Buffer.from(plaintext))).toBe(
        0
      )
    })

    it('open() rejects a frame declaring a plaintext over 1 MiB, before decrypting', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      // seq matches the fresh expected counter (0); the "ciphertext" is
      // garbage, but the oversize check MUST fire before decryption ever
      // runs, so this must reject as oversizePlaintext, not gcmAuthFailure.
      const oversizedFrame = new Uint8Array(8 + 1024 * 1024 + 1 + 16)
      oversizedFrame.set(encU64BE(0), 0)
      await expect(server.open(oversizedFrame)).rejects.toMatchObject({
        reason: 'oversizePlaintext',
      })
    })
  })

  describe('malformed frames', () => {
    it('rejects a frame too short to contain a seq and GCM tag', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      await expect(server.open(new Uint8Array(10))).rejects.toMatchObject({
        reason: 'malformedFrame',
      })
    })
  })

  describe('usage bounds (2^24 frames / 2^30 blocks per direction)', () => {
    it('seal() throws before exceeding the 2^24-frame bound', async () => {
      const client = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'client'
      )
      // Driving 2^24 real seals is infeasible in a unit test; this
      // whitebox-hacks the private outbound counter to the bound and
      // verifies the next seal is refused rather than silently allowed.
      ;(client as unknown as { outboundSeq: number }).outboundSeq = 2 ** 24
      await expect(client.seal(new Uint8Array(1))).rejects.toMatchObject({
        reason: 'usageBoundExceeded',
      })
    })

    it('seal() throws before exceeding the 2^30-block bound', async () => {
      const client = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'client'
      )
      ;(client as unknown as { outboundBlocks: number }).outboundBlocks =
        2 ** 30
      await expect(client.seal(new Uint8Array(1))).rejects.toMatchObject({
        reason: 'usageBoundExceeded',
      })
    })

    it('open() enforces the same frame bound on the receive side', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      ;(server as unknown as { inboundSeq: number }).inboundSeq = 2 ** 24
      // seq bytes must equal the (hacked) expected counter or the strict
      // sequence check would fire first; the "ciphertext" is otherwise
      // garbage since the bound check must reject before decryption runs.
      const frame = new Uint8Array(8 + 16)
      frame.set(encU64BE(2 ** 24), 0)
      await expect(server.open(frame)).rejects.toMatchObject({
        reason: 'usageBoundExceeded',
      })
    })

    it('open() enforces the same block bound on the receive side', async () => {
      const server = await EnvelopeCodec.create(
        H(inputs.keyC2S),
        H(inputs.keyS2C),
        'server'
      )
      ;(server as unknown as { inboundBlocks: number }).inboundBlocks = 2 ** 30
      const frame = new Uint8Array(8 + 1 + 16) // 1 plaintext byte -> 1 block
      frame.set(encU64BE(0), 0)
      await expect(server.open(frame)).rejects.toMatchObject({
        reason: 'usageBoundExceeded',
      })
    })
  })

  it('EnvelopeViolation instances are always the specific class', async () => {
    const server = await EnvelopeCodec.create(
      H(inputs.keyC2S),
      H(inputs.keyS2C),
      'server'
    )
    await expect(server.open(H(expected.frameC2S_seq1))).rejects.toBeInstanceOf(
      EnvelopeViolation
    )
  })
})
