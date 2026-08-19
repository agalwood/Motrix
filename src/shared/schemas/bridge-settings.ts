import type { BridgeSettings } from '@shared/types/settings'
import { z } from 'zod'

export const bridgeSettingsSchema = z.object({
  fixedPort: z
    .union([z.literal('auto'), z.number().int().min(1).max(65535)])
    .catch('auto'),
  // '' sentinel — seeded with randomUUID() by SettingsManager/migration,
  // never regenerated once set.
  instanceId: z.string().catch(''),
})

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings =
  bridgeSettingsSchema.parse({})
