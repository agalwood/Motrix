import { z } from 'zod'

// The adapter produces these failures. invalid_request is also a native error;
// the other adapter codes are never accepted from helper stdout. Each operation
// separately validates its wire response.
export const WindowsPlatformClientErrorCodeSchema = z.enum([
  'invalid_request',
  'helper_unavailable',
  'helper_failed',
  'helper_timeout',
  'output_limit',
  'invalid_response',
])

export const WindowsPlatformClientErrorSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(false),
    code: WindowsPlatformClientErrorCodeSchema,
  })
  .strict()

export type WindowsPlatformClientError = z.infer<
  typeof WindowsPlatformClientErrorSchema
>
