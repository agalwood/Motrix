import { z } from 'zod'

const milliseconds = z.number().int().nonnegative().safe()

/** Engine-relative timings for one magnet attempt; no cross-process clock arithmetic. */
export const magnetResolutionSchema = z
  .object({
    state: z.enum(['queued', 'resolving', 'ready', 'paused', 'failed']),
    attemptId: z.string().regex(/^[a-f0-9]{16}$/),
    revision: z.number().int().nonnegative().safe(),
    elapsedMs: milliseconds,
    cache: z.enum(['memory', 'persistent']).nullable(),
    milestones: z.object({
      admittedMs: milliseconds.optional(),
      firstCandidateMs: milliseconds.optional(),
      firstHandshakeMs: milliseconds.optional(),
      firstInfoBlockMs: milliseconds.optional(),
      infoVerifiedMs: milliseconds.optional(),
      verificationReadyMs: milliseconds.optional(),
      metadataReadyMs: milliseconds.optional(),
      selectionCommittedMs: milliseconds.optional(),
    }),
  })
  .refine(
    (snapshot) =>
      Object.values(snapshot.milestones).every(
        (at) => at === undefined || at <= snapshot.elapsedMs
      ),
    'Milestones must not be in the future'
  )

export type MagnetResolution = z.infer<typeof magnetResolutionSchema>
