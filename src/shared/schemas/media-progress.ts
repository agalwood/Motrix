import { z } from 'zod'

const bytes = z.number().finite().nonnegative()
const fraction = z.number().finite().min(0).max(1)

export const MediaProgressSchema = z.object({
  version: z.literal(1),
  phase: z.enum([
    'preparing',
    'downloading',
    'decrypting',
    'assembling',
    'muxing',
    'renaming',
  ]),
  download: z
    .object({
      progress: fraction,
      completedParts: z.number().int().nonnegative(),
      totalParts: z.number().int().positive(),
      totalBytes: bytes.nullable(),
    })
    .refine(
      (d) =>
        d.completedParts <= d.totalParts &&
        (d.progress === 1) === (d.completedParts === d.totalParts) &&
        d.progress >= d.completedParts / d.totalParts - 1e-10,
      'Inconsistent media download progress'
    ),
  muxProgress: fraction.nullable(),
  outputBytes: bytes.nullable(),
})

export type MediaProgressSnapshot = z.infer<typeof MediaProgressSchema>
export type MediaPhase = MediaProgressSnapshot['phase']
