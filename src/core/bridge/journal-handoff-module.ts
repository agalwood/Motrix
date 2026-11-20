import {
  type Activation,
  type DownloadHandoffJournal,
  HandoffJournalRefusal,
  type HandoffKey,
} from '@core/session/download-handoff-journal'
import type { TaskWithInstances } from '@core/session/motrix-database'
import {
  canonicalDownloadHandoffPayload,
  DownloadHandoffAbortParamsSchema,
  DownloadHandoffCommitParamsSchema,
  type DownloadHandoffKey,
  DownloadHandoffPrepareParamsSchema,
  DownloadHandoffStatusParamsSchema,
  type DownloadSubmitParams,
  ErrorCodes,
  Methods,
  makeMdxpError,
} from '@motrix/mdxp'
import type { ZodType } from 'zod'
import type { ExtensionHandoffModule } from './extension-handoff'
import type { MdxpSessionContext } from './mdxp-session-context'

export function journalHandoffModule(
  journal: DownloadHandoffJournal,
  host: {
    ttlMs: number
    directory: (
      download: DownloadSubmitParams,
      ctx: MdxpSessionContext
    ) => Promise<string>
    materialize: (
      intent: Activation,
      ctx: MdxpSessionContext
    ) => TaskWithInstances
    committed: (taskId: string, ctx: MdxpSessionContext) => Promise<void>
  }
): ExtensionHandoffModule {
  if (
    !Number.isSafeInteger(host.ttlMs) ||
    host.ttlMs < 1 ||
    host.ttlMs > 120000
  )
    throw new Error('Invalid handoff preparation lifetime')
  type Reply = ReturnType<DownloadHandoffJournal['status']>
  function method<T extends DownloadHandoffKey>(
    schema: ZodType<T>,
    run: (
      key: HandoffKey,
      p: T,
      ctx: MdxpSessionContext
    ) => Reply | Promise<Reply>
  ) {
    return {
      schema,
      handle: async (value: unknown, ctx: MdxpSessionContext) => {
        // Dispatch has already validated value against this exact schema.
        const p = value as T
        if (
          !ctx.isAuthorized() ||
          !ctx.isReady() ||
          ctx.identity.kind !== 'extension' ||
          !ctx.sessionKey
        )
          throw makeMdxpError(
            ErrorCodes.PermissionDenied,
            'Paired extension required'
          )
        try {
          const state = await run(
            {
              instanceId: p.instanceId,
              operationId: p.operationId,
              principal: ctx.sessionKey,
            },
            p,
            ctx
          )
          return {
            instanceId: p.instanceId,
            operationId: p.operationId,
            ...state,
          }
        } catch (error) {
          if (error instanceof HandoffJournalRefusal)
            throw makeMdxpError(
              {
                'instance-changed': ErrorCodes.HandoffInstanceChanged,
                'payload-conflict': ErrorCodes.HandoffPayloadConflict,
                'not-accepting': ErrorCodes.CapabilityNotSupported,
              }[error.reason],
              error.message
            )
          throw error
        }
      },
    }
  }
  return {
    capability: () => ({
      version: 1,
      instanceId: journal.instanceId,
      maxPreparedTtlMs: host.ttlMs,
      acceptingNew: journal.acceptingNewOperations,
    }),
    methods: {
      [Methods.DownloadHandoffPrepare]: method(
        DownloadHandoffPrepareParamsSchema,
        async (key, p, ctx) => {
          const canonical = canonicalDownloadHandoffPayload(p.download)
          return journal.prepare(
            key,
            canonical,
            () => host.directory(p.download, ctx),
            host.ttlMs,
            () => ctx.isAuthorized() && ctx.isReady()
          )
        }
      ),
      [Methods.DownloadHandoffStatus]: method(
        DownloadHandoffStatusParamsSchema,
        (key) => journal.status(key)
      ),
      [Methods.DownloadHandoffAbort]: method(
        DownloadHandoffAbortParamsSchema,
        (key) => journal.abort(key)
      ),
      [Methods.DownloadHandoffCommit]: method(
        DownloadHandoffCommitParamsSchema,
        async (key, p, ctx) => {
          const state = await journal.commit(key, p.payloadHash, (intent) => {
            if (!ctx.isAuthorized() || !ctx.isReady())
              throw makeMdxpError(
                ErrorCodes.PermissionDenied,
                'Extension no longer authorized'
              )
            return host.materialize(intent, ctx)
          })
          if (state.state === 'committed')
            await host.committed(state.taskId, ctx)
          return state
        }
      ),
    },
  }
}
