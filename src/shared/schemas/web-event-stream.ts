import { z } from 'zod'

export const WEB_EVENT_HEARTBEAT_MS = 15_000
export const WEB_EVENT_STALE_MS = 45_000
export const WEB_EVENT_CONNECT_TIMEOUT_MS = 10_000

// The first heartbeat advertises support. Older clients ignore this frame;
// newer clients do not require heartbeats from an older server.
export const webEventHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  version: z.literal(1),
})
export const WEB_EVENT_HEARTBEAT = webEventHeartbeatSchema.parse({
  type: 'heartbeat',
  version: 1,
})
// The server sends this control frame only to the socket being renewed.
// The browser returns it via authenticated same-origin HTTP with its current cookie.
export const webEventRenewalSchema = z
  .object({
    type: z.literal('session-renewal'),
    version: z.literal(1),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  })
  .strict()
export type WebEventRenewal = z.infer<typeof webEventRenewalSchema>
export const webEventFrameSchema = z.object({
  channel: z.string(),
  args: z.array(z.unknown()),
})
