import type { ZodType } from 'zod'
import type { MdxpSessionContext } from './mdxp-session-context'

// The host supplies the schemas from its candidate SDK. The stable build
// registers none of these operations unless the complete module is installed.
export const extensionHandoffMethods = [
  'download/handoff.prepare',
  'download/handoff.commit',
  'download/handoff.status',
  'download/handoff.abort',
] as const
export type ExtensionHandoffMethod = (typeof extensionHandoffMethods)[number]
export interface ExtensionHandoffModule {
  capability(): {
    version: 1
    instanceId: string
    maxPreparedTtlMs: number
    acceptingNew: boolean
  }
  methods: Record<
    ExtensionHandoffMethod,
    {
      schema: ZodType
      handle: (params: unknown, session: MdxpSessionContext) => Promise<unknown>
    }
  >
}
