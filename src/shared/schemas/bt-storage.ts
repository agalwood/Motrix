import { z } from 'zod'

export const btStorageRequestSchema = z
  .object({
    taskId: z.string().min(1),
    mode: z.enum(['move', 'locate', 'recheck']),
    directory: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    resume: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== 'recheck' && (!value.directory || !value.name))
      ctx.addIssue({ code: 'custom', message: 'A destination is required' })
  })

export type BtStorageRequest = z.input<typeof btStorageRequestSchema>

export interface BtVerificationResult {
  complete: boolean
  checkedPieces: number
  totalPieces: number
  validPieces: number
  /** Bounded examples; piece counts remain authoritative. */
  missingFiles: string[]
  invalidFiles: string[]
}

export interface BtStorageResult {
  taskId: string
  path: string
  verification: BtVerificationResult
  resumed: boolean
  resumeFailed?: boolean
}

export type BtStorageFailureReason =
  | 'unavailable'
  | 'busy'
  | 'destination'
  | 'conflict'
  | 'engine'
  | 'failed'
  | 'cancelled'
export type BtStorageCommandResult =
  | BtStorageResult
  | { error: BtStorageFailureReason }

export interface BtStorageProgress {
  taskId: string
  phase: 'checking' | 'moving' | 'resuming'
  checkedPieces: number
  totalPieces: number
}
