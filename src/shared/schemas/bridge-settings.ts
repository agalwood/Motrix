import { z } from 'zod'

// Settings for the WebSocket bridge that lets browser extensions hand
// downloads to Motrix (see MotrixAppSettings.browserBridgeEnabled for the
// master on/off switch).
export const bridgeSettingsSchema = z.object({
  // 'auto' tries the 16802-16806 candidate range; a number pins the bridge
  // to a single fixed port for networks/firewalls where the range is
  // unusable.
  fixedPort: z
    .union([z.literal('auto'), z.number().int().min(1).max(65535)])
    .catch('auto'),
  // Durable per-install identity, seeded once (migration or first launch)
  // and never regenerated afterward. '' is the unseeded sentinel. This is a
  // routing hint the extension uses to pick which candidate port to try
  // first (docs/bridge-pairing-protocol.md §4.1) — NOT a security signal.
  instanceId: z.string().catch(''),
})

export type BridgeSettings = z.infer<typeof bridgeSettingsSchema>

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings =
  bridgeSettingsSchema.parse({})
