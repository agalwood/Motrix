import { z } from 'zod'

export const pluginNetworkFailureSchema = z.object({
  reason: z.enum([
    'timeout',
    'dns',
    'proxyAuth',
    'proxyConnect',
    'certificate',
    'http',
    'cancelled',
    'network',
  ]),
  // Consumer deadlines or response validation can fail outside the transport.
  // Only report a route when the transport supplied that information.
  route: z.enum(['direct', 'proxy']).optional(),
  proxyEndpoint: z.string().optional(),
  targetHost: z.string(),
  status: z.number().int().optional(),
})

export type PluginNetworkFailure = z.infer<typeof pluginNetworkFailureSchema>

export const registryStatusSchema = z.object({
  cached: z.boolean(),
  lastSuccessAt: z.number().nullable(),
  error: pluginNetworkFailureSchema.nullable(),
})

export type RegistryStatus = z.infer<typeof registryStatusSchema>

export interface PluginNetworkFailureResult {
  networkError: PluginNetworkFailure
}
