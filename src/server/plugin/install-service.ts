import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  downloadGithubMoext,
  parseGithubSpec,
} from '@core/plugin/install/github-fetcher'
import type {
  PluginInstaller,
  PluginRuntimeHostLike,
  StageResult,
} from '@core/plugin/install/plugin-installer'
import {
  buildRegistryExpectation,
  type RegistryExpectation,
} from '@core/plugin/install/registry-expectation'
import type { SourceInput } from '@core/plugin/install/source-resolver'
import type { RegistryClient } from '@core/plugin/registry/registry-client'
import { downloadRegistryMoext } from '@core/plugin/registry/registry-fetcher'
import { AppError, ErrorCode } from '@shared/errors'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import { z } from 'zod'
import type { PluginUploadStore } from './upload-store'

const MAX_PLUGIN_PACKAGE_BYTES = 5 * 1024 * 1024

export const serverInstallPluginPayloadSchema = z.discriminatedUnion(
  'sourceType',
  [
    z.object({ sourceType: z.literal('github'), spec: z.string().min(1) }),
    z.object({ sourceType: z.literal('url'), url: z.string().min(1) }),
    z.object({
      sourceType: z.literal('local'),
      absPath: z.string().min(1),
      fileHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    z.object({
      sourceType: z.literal('upload'),
      uploadId: z.string().uuid(),
      fileHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    z.object({
      sourceType: z.literal('registry'),
      pluginId: z.string().regex(REGISTRY_PLUGIN_ID_RE),
    }),
  ]
)

export type ServerInstallPluginPayload = z.infer<
  typeof serverInstallPluginPayloadSchema
>

export interface ServerPluginInstallServiceOptions {
  installer: PluginInstaller
  registryClient: RegistryClient
  hostVersion: string
  pluginsDir: string
  allowedLocalRoots?: readonly string[]
  uploadStore?: PluginUploadStore
  fetchImpl?: typeof fetch
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the install error if cancellation races a closed/erroring body.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Cancellation is best-effort and must not mask the bounded-read error.
  }
}

async function readResponseBounded(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PLUGIN_PACKAGE_BYTES
  ) {
    await cancelResponseBody(response)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.package_too_large'
    )
  }
  if (!response.body) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.url_download_failed: empty body'
    )
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PLUGIN_PACKAGE_BYTES) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.package_too_large'
        )
      }
      chunks.push(value)
    }
  } catch (cause) {
    await cancelReader(reader)
    throw cause
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export class ServerPluginInstallService {
  private readonly downloadsDir: string
  private readonly allowedLocalRoots: readonly string[]
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: ServerPluginInstallServiceOptions) {
    this.downloadsDir = path.join(options.pluginsDir, '_downloads')
    this.allowedLocalRoots = [
      path.join(options.pluginsDir, '_uploads'),
      ...(options.allowedLocalRoots ?? []),
    ].map((root) => path.resolve(root))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async stage(
    rawPayload: unknown,
    runtimeHost?: PluginRuntimeHostLike
  ): Promise<StageResult> {
    const payload = serverInstallPluginPayloadSchema.parse(rawPayload)
    const materialized = await this.materialize(payload)
    try {
      return await this.options.installer.stage(
        materialized.moextPath,
        materialized.source,
        { expect: materialized.expect, runtimeHost }
      )
    } finally {
      if (materialized.temporary) {
        await rm(materialized.moextPath, { force: true }).catch(() => undefined)
      }
    }
  }

  private async materialize(payload: ServerInstallPluginPayload): Promise<{
    moextPath: string
    source: SourceInput
    expect?: RegistryExpectation
    temporary: boolean
  }> {
    await mkdir(this.downloadsDir, { recursive: true })
    switch (payload.sourceType) {
      case 'github': {
        const spec = parseGithubSpec(payload.spec)
        const target = this.downloadPath('github')
        await downloadGithubMoext(spec, target)
        return {
          moextPath: target,
          source: { type: 'github', spec: payload.spec },
          temporary: true,
        }
      }
      case 'url': {
        const url = this.parseHttpUrl(payload.url)
        const response = await this.fetchImpl(url, { redirect: 'follow' })
        if (!response.ok) {
          await cancelResponseBody(response)
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            `plugin.install.url_download_failed: ${response.status}`
          )
        }
        const target = this.downloadPath('url')
        await writeFile(target, await readResponseBounded(response), {
          mode: 0o600,
        })
        return {
          moextPath: target,
          source: { type: 'url', url: payload.url },
          temporary: true,
        }
      }
      case 'local': {
        const moextPath = await this.resolveAllowedLocalPath(payload.absPath)
        return {
          moextPath,
          source: {
            type: 'local',
            absPath: moextPath,
            fileHash: payload.fileHash,
          },
          temporary: false,
        }
      }
      case 'upload': {
        if (!this.options.uploadStore) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.upload_unavailable'
          )
        }
        const moextPath = await this.options.uploadStore.resolve(
          payload.uploadId,
          payload.fileHash
        )
        return {
          moextPath,
          source: {
            type: 'local',
            absPath: moextPath,
            fileHash: payload.fileHash,
          },
          temporary: true,
        }
      }
      case 'registry': {
        const entry = await this.options.registryClient.get(
          payload.pluginId,
          this.options.hostVersion
        )
        if (!entry) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.registry_entry_missing'
          )
        }
        if (!entry.compatible) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.registry_incompatible'
          )
        }
        const target = this.downloadPath('registry')
        await downloadRegistryMoext(entry, target, this.fetchImpl)
        return {
          moextPath: target,
          source: { type: 'registry', pluginId: payload.pluginId },
          expect: buildRegistryExpectation(entry),
          temporary: true,
        }
      }
    }
  }

  private downloadPath(kind: string): string {
    return path.join(this.downloadsDir, `${kind}-${randomUUID()}.moext`)
  }

  private parseHttpUrl(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.invalid_url'
      )
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.invalid_url'
      )
    }
    return url
  }

  private async resolveAllowedLocalPath(rawPath: string): Promise<string> {
    if (!path.isAbsolute(rawPath)) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_path_must_be_absolute'
      )
    }
    let candidate: string
    try {
      candidate = await realpath(rawPath)
      const info = await stat(candidate)
      if (!info.isFile()) throw new Error('not a regular file')
    } catch (cause) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_file_unreadable',
        cause
      )
    }
    const roots = await Promise.all(
      this.allowedLocalRoots.map((root) => realpath(root).catch(() => root))
    )
    if (!roots.some((root) => pathIsInside(root, candidate))) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_path_not_allowed'
      )
    }
    return candidate
  }
}
