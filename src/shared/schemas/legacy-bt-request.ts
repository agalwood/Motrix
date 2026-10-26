import { z } from 'zod'

const digest = z.string().regex(/^[a-f0-9]{64}$/)

/** A private backup reference, never a serialized proxy or credential. */
export const legacyBtRequestSourceSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    itemKey: z.string().min(1).max(128),
    snapshotDigest: digest,
    manifestDigest: digest,
    infoHash: z.string().regex(/^[a-f0-9]{40}$/),
    torrentDigest: digest.nullable(),
  })
  .strict()

export type LegacyBtRequestSource = z.infer<typeof legacyBtRequestSourceSchema>

/** A present but damaged reference must never fall back to ambient settings. */
export function getLegacyBtRequestSource(
  payload: Record<string, unknown>
): LegacyBtRequestSource | undefined {
  return Object.hasOwn(payload, 'legacyBtRequestSource')
    ? legacyBtRequestSourceSchema.parse(payload.legacyBtRequestSource)
    : undefined
}
