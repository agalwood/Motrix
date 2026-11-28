import { type DownloadHandoffCapability, Methods } from '@motrix/mdxp'
import type { ZodType } from 'zod'
import type { MdxpSessionContext } from './mdxp-session-context'

export const extensionHandoffMethods = [
  Methods.DownloadHandoffPrepare,
  Methods.DownloadHandoffCommit,
  Methods.DownloadHandoffStatus,
  Methods.DownloadHandoffAbort,
] as const
export type ExtensionHandoffMethod = (typeof extensionHandoffMethods)[number]
export interface ExtensionHandoffModule {
  capability(): DownloadHandoffCapability
  methods: Record<
    ExtensionHandoffMethod,
    {
      schema: ZodType
      handle: (params: unknown, session: MdxpSessionContext) => Promise<unknown>
    }
  >
}
