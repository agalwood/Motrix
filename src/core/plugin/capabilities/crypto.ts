// Exposes the `crypto` plugin capability, auto-injected alongside log/app/i18n.
// Thin stateless adapter over node:crypto: hash, hmac, randomBytes (sync, max
// 4096 bytes), and aes (CBC/GCM with PKCS#7 padding / 16-byte auth tag).
// All binary outputs are plain Uint8Array — not Buffer — so the API is portable
// to the QuickJS VM without Node-specific types leaking across the boundary.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
} from 'node:crypto'

export type HashAlg = 'sha1' | 'sha256' | 'sha384' | 'sha512'
/** Hash-only algorithms. md5 is exposed for legacy signing schemes (e.g.
 *  bilibili WBI w_rid = md5(query + mixinKey)); it is NOT offered for hmac. */
export type HashAlgWithMd5 = 'md5' | HashAlg
export type AesMode = 'cbc' | 'gcm'

export interface AesParams {
  mode: AesMode
  op: 'encrypt' | 'decrypt'
  /** 16 bytes → AES-128; 32 bytes → AES-256 */
  key: Uint8Array
  /** 16 bytes for CBC; 12 bytes for GCM */
  iv: Uint8Array
  data: Uint8Array
}

function toUint8Array(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function concat(a: Buffer, b: Buffer): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

/**
 * CryptoCapabilityHost — auto-injected into every plugin.
 * Thin, stateless adapter over node:crypto.
 * All byte outputs are plain Uint8Array (not Buffer) so they are
 * serialisable into QuickJS without node-specific type coupling.
 */
export class CryptoCapabilityHost {
  hash(alg: HashAlgWithMd5, input: string | Uint8Array): Promise<Uint8Array> {
    const buf = createHash(alg)
      .update(input as Buffer)
      .digest()
    return Promise.resolve(toUint8Array(buf))
  }

  hmac(
    alg: HashAlg,
    key: Uint8Array,
    input: string | Uint8Array
  ): Promise<Uint8Array> {
    const buf = createHmac(alg, key as Buffer)
      .update(input as Buffer)
      .digest()
    return Promise.resolve(toUint8Array(buf))
  }

  /** Synchronous. Range: 1..4096 inclusive. */
  randomBytes(n: number): Uint8Array {
    if (n < 1 || n > 4096) {
      throw new Error(`randomBytes: n out of range (1..max 4096, got ${n})`)
    }
    return toUint8Array(nodeRandomBytes(n))
  }

  aes(p: AesParams): Promise<Uint8Array> {
    const { mode, op, key, iv, data } = p

    // Validate key length
    const keyLen = key.byteLength
    if (keyLen !== 16 && keyLen !== 32) {
      return Promise.reject(
        new Error(`aes: key must be 16 or 32 bytes, got ${keyLen}`)
      )
    }
    const bits = keyLen === 16 ? 128 : 256
    const algo = `aes-${bits}-${mode}` as const

    // Validate IV length
    const expectedIvLen = mode === 'gcm' ? 12 : 16
    if (iv.byteLength !== expectedIvLen) {
      return Promise.reject(
        new Error(
          `aes: iv must be ${expectedIvLen} bytes for ${mode.toUpperCase()}, got ${iv.byteLength}`
        )
      )
    }

    try {
      if (op === 'encrypt') {
        const cipher = createCipheriv(algo, key as Buffer, iv as Buffer)
        const ct = Buffer.concat([
          cipher.update(data as Buffer),
          cipher.final(),
        ])
        if (mode === 'gcm') {
          const tag = (
            cipher as ReturnType<typeof createCipheriv> & {
              getAuthTag(): Buffer
            }
          ).getAuthTag()
          return Promise.resolve(concat(ct, tag))
        }
        return Promise.resolve(toUint8Array(ct))
      } else {
        // decrypt
        if (mode === 'gcm') {
          // last 16 bytes are the auth tag
          const tagOffset = data.byteLength - 16
          const ct = data.slice(0, tagOffset)
          const tag = data.slice(tagOffset)
          const decipher = createDecipheriv(
            algo,
            key as Buffer,
            iv as Buffer
          ) as ReturnType<typeof createDecipheriv> & {
            setAuthTag(tag: Buffer): void
          }
          decipher.setAuthTag(Buffer.from(tag))
          const pt = Buffer.concat([
            decipher.update(Buffer.from(ct)),
            decipher.final(),
          ])
          return Promise.resolve(toUint8Array(pt))
        } else {
          // CBC — PKCS#7 padding handled by default
          const decipher = createDecipheriv(algo, key as Buffer, iv as Buffer)
          const pt = Buffer.concat([
            decipher.update(Buffer.from(data)),
            decipher.final(),
          ])
          return Promise.resolve(toUint8Array(pt))
        }
      }
    } catch (err) {
      return Promise.reject(err)
    }
  }
}
