import { MAX_TORRENT_BASE64_SIZE } from '@shared/lib/torrent-meta'
import { Commands } from '@shared/protocol/commands'
import {
  errorCodes,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { z } from 'zod'

export const RPC_BODY_LIMIT_BYTES = 2 * 1024 * 1024
const MAX_LARGE_REQUESTS = 2

export type CommandRequest = FastifyRequest<{
  Body: { args?: unknown[] }
}>

// These identify which requests need the larger transport budget. Complete
// task validation remains in the command handler and shared task schema.
const createTorrentEnvelope = z.object({
  args: z.tuple([
    z.object({
      type: z.literal('bt'),
      payload: z.object({
        kind: z.literal('torrent-base64'),
        base64: z.string(),
      }),
    }),
  ]),
})
const addTorrentEnvelope = z.object({
  args: z.tuple([z.object({ base64: z.string() })]),
})

export async function registerTorrentCommandRoutes(
  app: FastifyInstance,
  dispatch: (
    channel: string,
    request: CommandRequest,
    reply: FastifyReply
  ) => Promise<unknown>,
  bodyLimitBytes: number
): Promise<void> {
  await app.register(async (routes) => {
    const bodySizes = new WeakMap<FastifyRequest, number>()
    const releases = new WeakMap<FastifyRequest, () => void>()
    const processing = new WeakSet<FastifyRequest>()
    let activeLargeRequests = 0

    // Keep Fastify's JSON parsing/prototype protection, recording actual wire
    // bytes before decoding (including whitespace and multibyte text).
    const parseJson = routes.getDefaultJsonParser('error', 'error')
    routes.removeAllContentTypeParsers()
    routes.addContentTypeParser<Buffer>(
      'application/json',
      { parseAs: 'buffer' },
      (request, body, done) => {
        bodySizes.set(request, body.byteLength)
        parseJson(request, body.toString('utf8'), done)
      }
    )

    routes.addHook('onRequest', async (request, reply) => {
      const contentLength = request.headers['content-length']
      if (
        contentLength !== undefined &&
        Number(contentLength) <= RPC_BODY_LIMIT_BYTES
      ) {
        return
      }
      if (activeLargeRequests >= MAX_LARGE_REQUESTS) {
        return reply
          .code(429)
          .send({ error: 'Too many large torrent requests' })
      }
      activeLargeRequests += 1
      const onClose = () => {
        // A disconnected client must not free a slot while its command still
        // owns the parsed torrent. The handler's finally releases that slot.
        if (!processing.has(request)) release()
      }
      const release = () => {
        if (!releases.delete(request)) return
        activeLargeRequests -= 1
        reply.raw.off('close', onClose)
      }
      releases.set(request, release)
      reply.raw.once('close', onClose)
    })
    routes.addHook('onResponse', async (request) => {
      releases.get(request)?.()
    })
    routes.addHook('onError', async (request) => {
      releases.get(request)?.()
    })
    routes.addHook('onRequestAbort', async (request) => {
      releases.get(request)?.()
    })

    // Match only these two decoded channel names. Static colon routes do
    // not match the percent-encoded colons sent by HttpWsTransport.
    const channels = [Commands.CreateTask, Commands.AddTorrentTask].join('|')
    routes.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
      `/rpc/command/:channel(^(?:${channels})$)`,
      {
        bodyLimit: bodyLimitBytes,
        preValidation: async (request, reply) => {
          const base64 =
            request.params.channel === Commands.CreateTask
              ? createTorrentEnvelope.safeParse(request.body).data?.args[0]
                  .payload.base64
              : addTorrentEnvelope.safeParse(request.body).data?.args[0].base64
          if (
            (base64 === undefined &&
              (bodySizes.get(request) ?? 0) > RPC_BODY_LIMIT_BYTES) ||
            (base64 !== undefined && base64.length > MAX_TORRENT_BASE64_SIZE)
          ) {
            return reply.send(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE())
          }
        },
      },
      async (request, reply) => {
        processing.add(request)
        try {
          return await dispatch(request.params.channel, request, reply)
        } finally {
          processing.delete(request)
          releases.get(request)?.()
        }
      }
    )
  })
}
