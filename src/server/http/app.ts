import type { EventBus } from '@core/events/event-bus'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { Commands } from '@shared/protocol/commands'
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
import { OPERATION_CHANNELS } from '@shared/protocol/operation-channels'
import { Queries } from '@shared/protocol/queries'
import { DirectoryPreferencesResultSchema } from '@shared/schemas/directory-preferences'
import { downloadsSettingsResultSchema } from '@shared/schemas/downloads-settings'
import { GeneralSettingsResultSchema } from '@shared/schemas/general-settings'
import {
  type ClientPairingCapabilities,
  clientPairingCapabilitiesSchema,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import {
  CreateServerDirectoryResultSchema,
  ListServerDirectoriesResultSchema,
  ListServerDirectoryLocationsResultSchema,
  ValidateServerDirectoryResultSchema,
  ValidateServerFileResultSchema,
} from '@shared/schemas/server-directory'
import { parseTaskInspectorActivitySnapshot } from '@shared/schemas/task-inspector-activity'
import { torrentRpcBodyLimitSchema } from '@shared/schemas/torrent-request-limits'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type { RemoteExtensionConfig } from '../bridge/remote-extension-config'
import type { FnosGatewayOptions } from '../platform/fnos/identity'
import {
  registerTorrentCreator,
  type TorrentCreatorDeps,
} from '../routes/torrent-creator'
import { bindEventHeartbeat } from './event-heartbeat'
import { bindEventBroadcaster } from './events'
import {
  canDeliverExtensionPairingCode,
  canDeliverGatewayExtensionPairingCode,
  filterExtensionPairingSnapshot,
  isExtensionPairingCodeEvent,
} from './extension-pairing-delivery'
import { registerFnosAuth } from './fnos-auth'
import { type NasGatewayOptions, registerNasAuth } from './nas-auth'
import { type OperatorAuthOptions, registerOperatorAuth } from './operator-auth'
import { ServiceUnavailableError } from './service-unavailable-error'
import {
  type CommandRequest,
  RPC_BODY_LIMIT_BYTES,
  registerTorrentCommandRoutes,
} from './torrent-command-routes'
import { createWebBasePath } from './web-base-path'

export { RPC_BODY_LIMIT_BYTES } from './torrent-command-routes'

const directoryResultSchemas = {
  [Commands.SaveDownloadsSettings]: downloadsSettingsResultSchema,
  [Queries.GetDownloadsSettingsDraft]: downloadsSettingsResultSchema,
  [Commands.MutateDirectoryPreferences]: DirectoryPreferencesResultSchema,
  [Commands.SaveGeneralSettings]: GeneralSettingsResultSchema,
  [Queries.GetGeneralSettingsDraft]: GeneralSettingsResultSchema,
  [Queries.GetDirectoryPreferences]: DirectoryPreferencesResultSchema,
  [Queries.ListServerDirectoryLocations]:
    ListServerDirectoryLocationsResultSchema,
  [Commands.CreateServerDirectory]: CreateServerDirectoryResultSchema,
  [Queries.ListServerDirectories]: ListServerDirectoriesResultSchema,
  [Queries.ValidateServerFile]: ValidateServerFileResultSchema,
  [Queries.ValidateServerDirectory]: ValidateServerDirectoryResultSchema,
}

function sendRpcValue(reply: FastifyReply, value: unknown) {
  // Fastify sends strings as plain text and undefined without a JSON body.
  // Every renderer RPC response must be consumable with Response.json().
  return reply.type('application/json').send(JSON.stringify(value ?? null))
}

async function directoryRpc(
  channel: string,
  body: unknown,
  handler: Handler
): Promise<unknown> {
  const schema =
    directoryResultSchemas[channel as keyof typeof directoryResultSchemas]
  const args =
    typeof body === 'object' && body !== null && 'args' in body
      ? body.args
      : undefined
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    Object.keys(body as object).some((key) => key !== 'args')
  ) {
    return { ok: false, error: { code: 'invalidPath' } }
  }
  try {
    return schema.parse(await handler(args[0]))
  } catch {
    return {
      ok: false,
      error: {
        code:
          channel === Commands.CreateServerDirectory
            ? 'creationOutcomeUnknown'
            : 'unavailable',
      },
    }
  }
}

export interface AppOptions {
  torrentCreator?: TorrentCreatorDeps
  /** Supported pairing surfaces, independent of the user's enable switch. */
  clientPairing?: ClientPairingCapabilities
  basePath?: string
  fnosGateway?: FnosGatewayOptions
  nasGateway?: NasGatewayOptions
  /** Torrent-only RPC budget; defaults to 8 MiB, configurable from 2 to 64 MiB. */
  torrentBodyLimitBytes?: number
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
  remoteExtensionConfig?: RemoteExtensionConfig
  eventBus?: EventBus
  getHiddenNotificationKinds?: () => readonly string[]
  pluginLogSource?: Pick<CapabilityHost, 'subscribeLog'>
  rendererDir?: string
  healthCheck?: () => { ok: boolean } | Promise<{ ok: boolean }>
}

export async function createApp(
  opts: AppOptions = {}
): Promise<FastifyInstance> {
  if (
    [opts.fnosGateway, opts.nasGateway, opts.operatorAuth].filter(Boolean)
      .length > 1
  )
    throw new Error('Authentication modes are mutually exclusive')
  const clientPairing =
    opts.clientPairing === undefined
      ? undefined
      : clientPairingCapabilitiesSchema.parse(opts.clientPairing)
  const webPath = createWebBasePath(opts.basePath)
  const app = Fastify({
    logger: false,
    bodyLimit: RPC_BODY_LIMIT_BYTES,
    requestTimeout: 120_000,
    rewriteUrl: webPath.rewriteUrl,
  })
  webPath.register(app)
  // Register the deny-by-default operator gate FIRST so its onRequest hook runs
  // before every route (including /api/* added by the caller post-createApp and
  // the /rpc/events WS upgrade).
  const nasGateway = opts.nasGateway ?? opts.fnosGateway
  const operatorSessions = opts.nasGateway
    ? registerNasAuth(app, opts.nasGateway, clientPairing)
    : opts.fnosGateway
      ? registerFnosAuth(app, opts.fnosGateway, clientPairing)
      : opts.operatorAuth
        ? registerOperatorAuth(app, {
            ...opts.operatorAuth,
            clientPairing: clientPairing ?? opts.operatorAuth.clientPairing,
          })
        : undefined
  if (!operatorSessions) {
    app.get('/rpc/auth/status', async () => ({
      authed: true,
      mode: 'unrestricted',
      canLogout: false,
      ...(clientPairing ? { clientPairing } : {}),
    }))
  }
  if (opts.torrentCreator)
    registerTorrentCreator(app, opts.torrentCreator, (req) =>
      operatorSessions?.principal(req)
    )
  const commands = opts.commandHandlers ?? {}
  const queries = opts.queryHandlers ?? {}
  const bridgeCommands = opts.bridgeCommandHandlers ?? {}
  const bridgeQueries = opts.bridgeQueryHandlers ?? {}

  app.get('/healthz', async (_request, reply) => {
    const health = opts.healthCheck ? await opts.healthCheck() : { ok: true }
    return reply.code(health.ok ? 200 : 503).send(health)
  })

  const dispatchCommand = async (
    channel: string,
    req: CommandRequest,
    reply: FastifyReply
  ) => {
    const handler =
      commands[channel as keyof typeof commands] ?? bridgeCommands[channel]
    if (!handler) return reply.code(404).send({ error: 'unknown channel' })
    if (channel === BridgeCommands.ClaimExtensionPair) {
      reply.header('cache-control', 'no-store')
      const principal = operatorSessions?.principal(req)
      if (
        !(
          principal &&
          (nasGateway
            ? canDeliverGatewayExtensionPairingCode(
                opts.remoteExtensionConfig,
                req.headers[WEB_ORIGIN_HEADER]
              )
            : canDeliverExtensionPairingCode(
                opts.remoteExtensionConfig,
                req,
                principal.id.startsWith('bearer:')
              ))
        )
      )
        return reply
          .code(403)
          .send({ error: 'Pairing code delivery unavailable' })
    }

    if (
      channel === Commands.CreateServerDirectory ||
      channel === Commands.MutateDirectoryPreferences ||
      channel === Commands.SaveGeneralSettings ||
      channel === Commands.SaveDownloadsSettings
    ) {
      return directoryRpc(channel, req.body, handler)
    }
    try {
      if (OPERATION_CHANNELS.has(channel)) {
        const owner = operatorSessions?.principal(req)
        if (!owner) return reply.code(401).send({ error: 'unauthorized' })
        return sendRpcValue(reply, await handler(owner, req.body?.args?.[0]))
      }
      return sendRpcValue(reply, await handler(...(req.body?.args ?? [])))
    } catch (err) {
      req.log.error({ err }, 'command handler failed')
      return reply
        .code(err instanceof ServiceUnavailableError ? 503 : 500)
        .send({ error: (err as Error).message })
    }
  }

  await registerTorrentCommandRoutes(
    app,
    dispatchCommand,
    torrentRpcBodyLimitSchema.parse(opts.torrentBodyLimitBytes)
  )
  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
    '/rpc/command/:channel',
    (req, reply) => dispatchCommand(req.params.channel, req, reply)
  )

  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
    '/rpc/query/:channel',
    async (req, reply) => {
      const usesSharedEnvelope =
        req.params.channel === Queries.GetTaskInspectorActivity
      // An installation without a pairing surface has no pending requests.
      // Once configured, NAS hosts use the ordinary operator-gated inbox.
      if (
        nasGateway &&
        !clientPairing?.cli &&
        !clientPairing?.extension &&
        req.params.channel === BridgeQueries.ListPendingPairRequests
      )
        return []
      const handler =
        queries[req.params.channel as keyof typeof queries] ??
        bridgeQueries[req.params.channel]
      if (!handler) return reply.code(404).send({ error: 'unknown channel' })
      if (
        req.params.channel === Queries.ListServerDirectories ||
        req.params.channel === Queries.ValidateServerDirectory ||
        req.params.channel === Queries.ValidateServerFile ||
        req.params.channel === Queries.GetDirectoryPreferences ||
        req.params.channel === Queries.GetGeneralSettingsDraft ||
        req.params.channel === Queries.GetDownloadsSettingsDraft ||
        req.params.channel === Queries.ListServerDirectoryLocations
      ) {
        return directoryRpc(req.params.channel, req.body, handler)
      }
      try {
        const args = req.body?.args
        if (usesSharedEnvelope) {
          assertTaskInspectorActivityArguments(args)
        }
        const value = await handler(...(args ?? []))
        if (
          req.params.channel === BridgeQueries.ListPendingPairRequests &&
          !(
            operatorSessions?.principal(req) &&
            canDeliverExtensionPairingCode(
              opts.remoteExtensionConfig,
              req,
              operatorSessions?.principal(req)?.id.startsWith('bearer:') ===
                true
            )
          )
        ) {
          return filterExtensionPairingSnapshot(value)
        }
        if (!usesSharedEnvelope) return sendRpcValue(reply, value)
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
    const broadcaster = bindEventBroadcaster(
      opts.eventBus,
      opts.getHiddenNotificationKinds
    )
    const unsubscribePluginLogs = opts.pluginLogSource?.subscribeLog(
      (pluginId, entry) => {
        broadcaster.broadcast(`${Events.PluginLog}:${pluginId}`, [entry])
      }
    )
    if (unsubscribePluginLogs) {
      app.addHook('onClose', async () => unsubscribePluginLogs())
    }
    await app.register(websocket)
    app.get('/rpc/events', { websocket: true }, (socket, request) => {
      const session = operatorSessions?.bindSocket(request, socket)
      const allowPairingCode =
        operatorSessions?.principal(request) !== undefined &&
        canDeliverExtensionPairingCode(
          opts.remoteExtensionConfig,
          request,
          operatorSessions?.principal(request)?.id.startsWith('bearer:') ===
            true
        )
      broadcaster.register(
        socket,
        session?.eligible,
        (channel, args) =>
          allowPairingCode || !isExtensionPairingCodeEvent(channel, args)
      )
      const stopHeartbeat = bindEventHeartbeat(socket)
      const cleanup = () => {
        stopHeartbeat()
        broadcaster.unregister(socket)
        session?.dispose()
      }
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
      const isApi = req.url.startsWith('/api/')
      if (
        isGet &&
        !isRpc &&
        !isApi &&
        !isHealth &&
        (!webPath.basePath || req.url.split('?')[0] === '/')
      ) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }

  return app
}
