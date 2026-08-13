import type { FastifyInstance } from 'fastify'
import {
  MAX_PLUGIN_UPLOAD_BYTES,
  type PluginUploadStore,
} from '../plugin/upload-store'

export const PLUGIN_UPLOAD_CONTENT_TYPE = 'application/vnd.motrix.moext'

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function registerPluginUploadRoute(
  app: FastifyInstance,
  store: PluginUploadStore
): void {
  if (!app.hasContentTypeParser(PLUGIN_UPLOAD_CONTENT_TYPE)) {
    app.addContentTypeParser(
      PLUGIN_UPLOAD_CONTENT_TYPE,
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body)
    )
  }

  app.post<{ Body: Buffer }>(
    '/api/plugins/uploads',
    { bodyLimit: MAX_PLUGIN_UPLOAD_BYTES },
    async (request, reply) => {
      try {
        const encodedName = headerValue(request.headers['x-motrix-file-name'])
        const fileName = decodeURIComponent(encodedName)
        // The server is the authority for the retained package digest. Older
        // clients may still send a claimed digest, which is verified when
        // present; omitting it keeps uploads usable on plain LAN HTTP where
        // browser Web Crypto is not exposed.
        const claimedHash =
          headerValue(request.headers['x-motrix-file-sha256']).trim() ||
          undefined
        const reference = await store.put(request.body, claimedHash, fileName)
        return reply.code(201).send(reference)
      } catch (cause) {
        request.log.warn({ err: cause }, 'plugin upload rejected')
        return reply.code(400).send({
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
  )
}
