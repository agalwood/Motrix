import type { NatSettings } from '@shared/types/settings'
import { z } from 'zod'

export const natSettingsSchema = z.object({
  enabled: z.boolean().catch(true),
  preferredProtocol: z.enum(['auto', 'pcp', 'natpmp', 'upnp']).catch('auto'),
  mappingTtl: z.number().int().min(1200).max(7200).catch(7200),
  natTypeDetectionEnabled: z.boolean().catch(false),
  stunServers: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9.-]+:\d+$/i, 'invalid STUN server format')
        .max(253)
    )
    .max(10)
    .catch([]),
  portReachabilityCheckEnabled: z.boolean().catch(false),
  portCheckerEndpoints: z
    .array(
      z.string().url().startsWith('https://', 'port checker must use HTTPS')
    )
    .max(5)
    .catch([]),
  autoDiagnostic: z.boolean().catch(false),
  diagnosticIntervalSec: z.number().int().min(300).max(86400).catch(3600),
})

export const DEFAULT_NAT_SETTINGS: NatSettings = natSettingsSchema.parse({})
