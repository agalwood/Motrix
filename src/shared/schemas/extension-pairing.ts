import { BrowserSchema } from '@shared/protocol/bridge'
import { z } from 'zod'

export const claimExtensionPairParamsSchema = z
  .object({
    browser: BrowserSchema,
    pairingNonce: z.string().min(1).max(256),
    extensionId: z.string().min(1).max(256),
    expectedUsername: z.string().min(1).max(256),
  })
  .strict()
export type ClaimExtensionPairParams = z.infer<
  typeof claimExtensionPairParamsSchema
>
export const claimExtensionPairResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      code: z.string().min(1).max(32),
      expiresInMs: z.number().int().positive().max(120_000),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
])
export type ClaimExtensionPairResult = z.infer<
  typeof claimExtensionPairResultSchema
>
