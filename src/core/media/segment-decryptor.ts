import { createDecipheriv } from 'node:crypto'

export class SegmentDecryptor {
  private keyCache: Map<string, Promise<Uint8Array>>

  private defaultFetchKey: (uri: string) => Promise<Uint8Array>

  constructor(fetchKey?: (uri: string) => Promise<Uint8Array>) {
    this.keyCache = new Map()

    if (fetchKey) {
      this.defaultFetchKey = fetchKey
    } else {
      this.defaultFetchKey = async (uri: string) => {
        const response = await fetch(uri)
        const buffer = await response.arrayBuffer()
        const key = new Uint8Array(buffer)
        if (key.length !== 16) {
          throw new Error(`Key must be 16 bytes, got ${key.length} from ${uri}`)
        }
        return key
      }
    }
  }

  decrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    // Validate key and IV lengths
    if (key.length !== 16) {
      throw new Error(`Key must be 16 bytes, got ${key.length}`)
    }
    if (iv.length !== 16) {
      throw new Error(`IV must be 16 bytes, got ${iv.length}`)
    }

    // Convert Uint8Array to Buffer for crypto operations
    const keyBuffer = Buffer.from(key)
    const ivBuffer = Buffer.from(iv)
    const ciphertextBuffer = Buffer.from(ciphertext)

    // Try with PKCS7 auto-padding first
    try {
      const decipher = createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer)
      const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
      ])
      return new Uint8Array(plaintext)
    } catch (err) {
      // Only fall back if error is PKCS7-padding related
      const msg = err instanceof Error ? err.message.toLowerCase() : ''
      const isPaddingError =
        msg.includes('bad decrypt') || msg.includes('final block')
      if (!isPaddingError) {
        throw err
      }

      // PKCS7 padding error, retry with no auto-padding
      const decipher = createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer)
      decipher.setAutoPadding(false)
      const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
      ])
      return new Uint8Array(plaintext)
    }
  }

  async getKey(uri: string): Promise<Uint8Array> {
    // Return cached promise if available (concurrent-safe)
    const cached = this.keyCache.get(uri)
    if (cached) {
      return cached
    }

    // Store the promise immediately to handle concurrent calls
    const keyPromise = this.defaultFetchKey(uri)
    this.keyCache.set(uri, keyPromise)

    return keyPromise
  }
}
