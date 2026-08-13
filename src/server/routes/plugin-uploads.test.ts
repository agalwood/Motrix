import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../http/app'
import { PluginUploadStore } from '../plugin/upload-store'
import {
  PLUGIN_UPLOAD_CONTENT_TYPE,
  registerPluginUploadRoute,
} from './plugin-uploads'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-upload-route-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('plugin upload route', () => {
  it('returns a server-hashed opaque reference without a client digest', async () => {
    const app = Fastify()
    registerPluginUploadRoute(app, new PluginUploadStore(root))
    const bytes = Buffer.from('plugin bytes')
    const fileHash = createHash('sha256').update(bytes).digest('hex')

    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/uploads',
      headers: {
        'content-type': PLUGIN_UPLOAD_CONTENT_TYPE,
        'x-motrix-file-name': encodeURIComponent('test.moext'),
      },
      payload: bytes,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      uploadId: expect.stringMatching(/^[0-9a-f-]+$/),
      fileHash,
    })
    await app.close()
  })

  it('rejects an upload whose claimed hash is false', async () => {
    const app = Fastify()
    registerPluginUploadRoute(app, new PluginUploadStore(root))
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/uploads',
      headers: {
        'content-type': PLUGIN_UPLOAD_CONTENT_TYPE,
        'x-motrix-file-name': encodeURIComponent('test.moext'),
        'x-motrix-file-sha256': '0'.repeat(64),
      },
      payload: Buffer.from('plugin bytes'),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'plugin.install.local_file_hash_mismatch',
    })
    await app.close()
  })

  it('is covered by the operator control-plane authentication gate', async () => {
    const app = await createApp({
      operatorAuth: { operatorToken: 'operator-secret' },
    })
    registerPluginUploadRoute(app, new PluginUploadStore(root))
    const bytes = Buffer.from('plugin bytes')
    const fileHash = createHash('sha256').update(bytes).digest('hex')
    const request = {
      method: 'POST' as const,
      url: '/api/plugins/uploads',
      headers: {
        'content-type': PLUGIN_UPLOAD_CONTENT_TYPE,
        'x-motrix-file-name': encodeURIComponent('test.moext'),
        'x-motrix-file-sha256': fileHash,
      },
      payload: bytes,
    }

    expect((await app.inject(request)).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...request.headers,
            authorization: 'Bearer operator-secret',
          },
        })
      ).statusCode
    ).toBe(201)
    await app.close()
  })
})
