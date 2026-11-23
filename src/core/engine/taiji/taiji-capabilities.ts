import { AppError, ErrorCode } from '@shared/errors'
import { z } from 'zod'

/** Native facts, separate from whether a particular task may mutate now. */
const capabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^taiji\/\d+\.\d+\.\d+(?:[-+].*)?$/),
  rpcExtensions: z.array(z.string()),
})

export function parseTaijiCapabilities(value: unknown) {
  const parsed = capabilitiesSchema.safeParse(value)
  if (!parsed.success)
    throw new AppError(
      ErrorCode.EngineProtocolError,
      'Invalid native taiji capability report',
      parsed.error
    )
  return parsed.data
}
