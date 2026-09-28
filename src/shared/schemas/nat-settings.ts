import type { NatSettings } from '@shared/types/settings'
import { z } from 'zod'
import { settingsInputObject } from './settings-input'

export const stunServerInputSchema = z
  .string()
  .max(253)
  .refine(
    (value) => {
      const match = /^([a-z0-9.-]+):(\d+)$/i.exec(value)
      return (
        match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 65535
      )
    },
    { params: { settingIssue: 'stunServer' } }
  )

export const portCheckerInputSchema = z.string().refine(
  (value) => {
    try {
      return /^https:\/\//i.test(value) && new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  },
  { params: { settingIssue: 'httpsUrl' } }
)

export const natSettingsSchema = z.object({
  enabled: z.boolean().catch(true),
  preferredProtocol: z.enum(['auto', 'pcp', 'natpmp', 'upnp']).catch('auto'),
  mappingTtl: z.number().int().min(1200).max(7200).catch(7200),
  natTypeDetectionEnabled: z.boolean().catch(false),
  stunServers: z.array(stunServerInputSchema).max(10).catch([]),
  portReachabilityCheckEnabled: z.boolean().catch(false),
  portCheckerEndpoints: z.array(portCheckerInputSchema).max(5).catch([]),
  autoDiagnostic: z.boolean().catch(false),
  diagnosticIntervalSec: z.number().int().min(300).max(86400).catch(3600),
})

export const DEFAULT_NAT_SETTINGS: NatSettings = natSettingsSchema.parse({})

export const natSettingsInputSchema = settingsInputObject(natSettingsSchema)
