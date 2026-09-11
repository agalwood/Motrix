import { z } from 'zod'

export const byteUnitSystemSchema = z.enum(['system', 'decimal', 'binary'])
export type ByteUnitPreference = z.infer<typeof byteUnitSystemSchema>
export type ByteUnitSystem = Exclude<ByteUnitPreference, 'system'>
export const DEFAULT_BYTE_UNIT_PREFERENCE: ByteUnitPreference = 'system'
export const DEFAULT_BYTE_UNIT_SYSTEM: ByteUnitSystem = 'decimal'

/** Accepts a native platform or the browser device platform, never the server OS. */
export function resolveByteUnitSystem(
  preference: ByteUnitPreference,
  platform: string
): ByteUnitSystem {
  if (preference !== 'system') return preference
  if (/darwin|mac|iphone|ipad/i.test(platform)) return 'decimal'
  return /win|linux|android/i.test(platform) ? 'binary' : 'decimal'
}
