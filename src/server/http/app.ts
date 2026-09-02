import type { EventBus } from '@core/events/event-bus'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import {
  assertTaskInspectorActivityArguments,
  makeProtocolFailure,
  makeProtocolSuccess,
} from '@shared/protocol/errors'
import { Events } from '@shared/protocol/events'
import type {
  CommandHandlerMap,
  Handler,
  QueryHandlerMap,
} from '@shared/protocol/handler-types'
import { Queries } from '@shared/protocol/queries'
import { parseTaskInspectorActivitySnapshot } from '@shared/schemas/task-inspector-activity'
import Fastify, { type FastifyInstance } from 'fastify'
import { bindEventBroadcaster } from './events'
import { type OperatorAuthOptions, registerOperatorAuth } from './operator-auth'
import { ServiceUnavailableError } from './service-unavailable-error'

export const RPC_BODY_LIMIT_BYTES = 2 * 1024 * 1024

export interface AppOptions {
  commandHandlers?: CommandHandlerMap
  queryHandlers?: QueryHandlerMap
  /**
   * When set, gates the control plane (`/rpc/*`, `/api/*`, `/rpc/events`) on the
   * machine-owner operator token (Spec 9). Omitting it leaves the app open —
   * only for unit tests / embedding; the server entry ALWAYS provides it.
   */
  operatorAuth?: OperatorAuthOptions
  /**
   * `bridge:*` command/query handlers (Spec 7b). Kept separate from the generic
   * Command/Query maps because bridge channels have their own prefix + types.
   * The route falls back to these. Passed by reference so the server can
   * populate them AFTER the (non-fatal, later-bootstrapped) bridge comes up.
   */
  bridgeCommandHandlers?: Record<string, Handler>
  bridgeQueryHandlers?: Record<string, Handler>
  eventBus?: EventBus
  pluginLogSource?: Pick<CapabilityHost, 'subscribeLog'>
  rendererDir?: string
  healthCheck?: () => { ok: boolean } | Promise<{ ok: boolean }>
}

export async function createApp(
  opts: AppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: RPC_BODY_LIMIT_BYTES,
  })
  // Register the deny-by-default operator gate FIRST so its onRequest hook runs
  // before every route (including /api/* added by the caller post-createApp and
  // the /rpc/events WS upgrade).
  if (opts.operatorAuth) registerOperatorAuth(app, opts.operatorAuth)
  const commands = opts.commandHandlers ?? {}
  const queries = opts.queryHandlers ?? {}
  const bridgeCommands = opts.bridgeCommandHandlers ?? {}
  const bridgeQueries = opts.bridgeQueryHandlers ?? {}

  app.get('/healthz', async (_request, reply) => {
    const health = opts.healthCheck ? await opts.healthCheck() : { ok: true }
    return reply.code(health.ok ? 200 : 503).send(health)
  })

  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
    '/rpc/command/:channel',
    async (req, reply) => {
      const handler =
        commands[req.params.channel as keyof typeof commands] ??
        bridgeCommands[req.params.channel]
      if (!handler) return reply.code(404).send({ error: 'unknown channel' })
      try {
        return await handler(...(req.body?.args ?? []))
      } catch (err) {
        req.log.error({ err }, 'command handler failed')
        return reply
          .code(err instanceof ServiceUnavailableError ? 503 : 500)
          .send({ error: (err as Error).message })
      }
    }
  )

  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
    '/rpc/query/:channel',
    async (req, reply) => {
      const usesSharedEnvelope =
        req.params.channel === Queries.GetTaskInspectorActivity
      const handler =
        queries[req.params.channel as keyof typeof queries] ??
        bridgeQueries[req.params.channel]
      if (!handler) return reply.code(404).send({ error: 'unknown channel' })
      try {
        const args = req.body?.args
        if (usesSharedEnvelope) {
          assertTaskInspectorActivityArguments(args)
        }
        const value = await handler(...(args ?? []))
        if (!usesSharedEnvelope) return value
        const snapshot = parseTaskInspectorActivitySnapshot(value)
        if (!snapshot) {
          throw new Error('Invalid Task Inspector Activity snapshot')
        }
        return makeProtocolSuccess(snapshot)
      } catch (err) {
        req.log.error({ err }, 'query handler failed')
        if (usesSharedEnvelope) {
          return reply.code(200).send(makeProtocolFailure(err))
        }
        return reply
          .code(err instanceof ServiceUnavailableError ? 503 : 500)
          .send({ error: (err as Error).message })
      }
    }
  )

  if (opts.eventBus) {
    const broadcaster = bindEventBroadcaster(opts.eventBus)
    const unsubscribePluginLogs = opts.pluginLogSource?.subscribeLog(
      (pluginId, entry) => {
        broadcaster.broadcast(`${Events.PluginLog}:${pluginId}`, [entry])
      }
    )
    if (unsubscribePluginLogs) {
      app.addHook('onClose', async () => unsubscribePluginLogs())
    }
    await app.register(websocket)
    app.get('/rpc/events', { websocket: true }, (socket) => {
      broadcaster.register(socket)
      const cleanup = () => broadcaster.unregister(socket)
      socket.on('close', cleanup)
      socket.on('error', cleanup)
    })
  }

  if (opts.rendererDir) {
    await app.register(fastifyStatic, {
      root: opts.rendererDir,
      prefix: '/',
      wildcard: false,
    })
    // SPA fallback: return index.html for any GET that isn't /rpc/* or /healthz.
    app.setNotFoundHandler(async (req, reply) => {
      const isGet = req.method === 'GET'
      const isRpc = req.url.startsWith('/rpc/')
      const isHealth = req.url === '/healthz'
      if (isGet && !isRpc && !isHealth) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }

  return app
}
