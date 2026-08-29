import { readFile, stat } from 'node:fs/promises'
import { getLogger } from '@core/logger'
import {
  REGISTRY_URL,
  type RegistryFile,
  RegistryFileSchema,
  type RegistryPluginDTO,
} from '@shared/schemas/registry'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { semverSatisfies } from '../manifest/parse'

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024
const MAX_CACHE_BYTES = MAX_REGISTRY_BYTES + 64 * 1024

async function cancelResponseBody(
  response: Response,
  reason?: unknown
): Promise<void> {
  try {
    await response.body?.cancel(reason)
  } catch {
    // Preserve the refresh result when cancellation races a closed body.
  }
}

const CacheEnvelopeSchema = z.object({
  cacheFormat: z.literal(2),
  etag: z.string().nullable(),
  fetchedAt: z.number(),
  raw: z.unknown(),
})
type CacheEnvelope = z.infer<typeof CacheEnvelopeSchema>

interface CacheState extends CacheEnvelope {
  file: RegistryFile
}

type RegistryStat = (path: string) => Promise<{ size: number }>
type RegistryReadFile = (path: string) => Promise<string>

export interface RegistryClientOptions {
  /** Absolute path of the last-good cache file (userData/registry-cache.json). */
  cachePath: string
  url?: string
  ttlMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  /** Injectable clock for tests. */
  now?: () => number
  /** Test seam for a delayed or oversized cache read. */
  statImpl?: RegistryStat
  /** Test seam for a delayed cache read. */
  readFileImpl?: RegistryReadFile
}

/**
 * Defensive read-side client for the shared Marketplace registry.
 *
 * Public methods never throw: failures retain a validated last-good snapshot,
 * or return null when none exists. Network refreshes are lazy and deduplicated.
 */
export class RegistryClient {
  private readonly url: string
  private readonly cachePath: string
  private readonly ttlMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly statImpl: RegistryStat
  private readonly readFileImpl: RegistryReadFile
  private readonly log = getLogger('plugin-registry')

  private cache: CacheState | null = null
  private diskLoadPromise: Promise<void> | null = null
  private inflight: Promise<RegistryFile | null> | null = null
  // Annotated entries are memoized by parsed-file identity. A 304 retains that
  // identity; only a valid replacement body produces a new RegistryFile.
  private annotated: {
    file: RegistryFile
    hostVersion: string
    entries: RegistryPluginDTO[]
  } | null = null

  constructor(options: RegistryClientOptions) {
    this.cachePath = options.cachePath
    this.url = options.url ?? REGISTRY_URL
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.statImpl = options.statImpl ?? stat
    this.readFileImpl =
      options.readFileImpl ?? ((cachePath) => readFile(cachePath, 'utf8'))
  }

  /** Last-good registry, refreshed over the network only when stale. */
  async load(): Promise<RegistryFile | null> {
    await this.loadDiskOnce()
    if (this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.file
    }
    return this.refresh()
  }

  /** Force a conditional refetch; keeps last-good on any failure. */
  refresh(): Promise<RegistryFile | null> {
    this.inflight ??= this.refreshAfterDisk().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Registry entries annotated with the host compatibility gate. */
  async list(hostVersion: string): Promise<RegistryPluginDTO[]> {
    const file = await this.load()
    if (!file) return []
    if (
      this.annotated?.file !== file ||
      this.annotated.hostVersion !== hostVersion
    ) {
      this.annotated = {
        file,
        hostVersion,
        entries: file.plugins.map((entry) => ({
          ...entry,
          compatible: semverSatisfies(hostVersion, entry.engines.motrix),
        })),
      }
    }
    return this.annotated.entries
  }

  async get(
    id: string,
    hostVersion: string
  ): Promise<RegistryPluginDTO | null> {
    const entries = await this.list(hostVersion)
    return entries.find((entry) => entry.id === id) ?? null
  }

  private async refreshAfterDisk(): Promise<RegistryFile | null> {
    await this.loadDiskOnce()
    return this.doRefresh()
  }

  private async doRefresh(): Promise<RegistryFile | null> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('registry request timed out')
        controller.abort(error)
        reject(error)
      }, FETCH_TIMEOUT_MS)
    })

    try {
      const headers: Record<string, string> = {}
      if (this.cache?.etag) headers['if-none-match'] = this.cache.etag

      const fetchResponse = this.fetchImpl(this.url, {
        headers,
        signal: controller.signal,
      }).then(async (response) => {
        // A custom fetch implementation may ignore AbortSignal and resolve
        // after the deadline already won the race. Dispose that late response
        // instead of leaving its body and connection unowned.
        if (controller.signal.aborted) {
          await cancelResponseBody(response, controller.signal.reason)
          throw controller.signal.reason
        }
        return response
      })
      const res = await Promise.race([fetchResponse, deadline])

      if (res.status === 304 && this.cache) {
        await cancelResponseBody(res)
        this.cache = { ...this.cache, fetchedAt: this.now() }
        await this.persist()
        return this.cache.file
      }
      if (!res.ok) {
        await cancelResponseBody(res)
        throw new Error(`registry responded ${res.status}`)
      }

      const encoded = await Promise.race([
        this.readBoundedResponse(res, controller),
        deadline,
      ])
      const raw: unknown = JSON.parse(encoded)
      const file = RegistryFileSchema.parse(raw)
      this.cache = {
        cacheFormat: 2,
        etag: res.headers.get('etag'),
        fetchedAt: this.now(),
        raw,
        file,
      }
      await this.persist()
      return file
    } catch (error) {
      this.log.warn({ error }, 'registry refresh failed; keeping last-good')
      return this.cache?.file ?? null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async readBoundedResponse(
    response: Response,
    controller: AbortController
  ): Promise<string> {
    const contentLength = response.headers.get('content-length')?.trim()
    if (contentLength && /^\d+$/.test(contentLength)) {
      const declaredBytes = Number(contentLength)
      if (declaredBytes > MAX_REGISTRY_BYTES) {
        const error = new Error('registry body exceeds 4 MiB')
        controller.abort(error)
        await response.body?.cancel(error).catch(() => {})
        throw error
      }
    }

    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let totalBytes = 0
    let encoded = ''
    const cancelOnAbort = () => {
      void reader.cancel(controller.signal.reason).catch(() => {})
    }
    controller.signal.addEventListener('abort', cancelOnAbort, { once: true })

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > MAX_REGISTRY_BYTES) {
          const error = new Error('registry body exceeds 4 MiB')
          controller.abort(error)
          await reader.cancel(error).catch(() => {})
          throw error
        }
        encoded += decoder.decode(value, { stream: true })
      }
      encoded += decoder.decode()
      return encoded
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error)
      await reader.cancel(error).catch(() => {})
      throw error
    } finally {
      controller.signal.removeEventListener('abort', cancelOnAbort)
      reader.releaseLock()
    }
  }

  private loadDiskOnce(): Promise<void> {
    this.diskLoadPromise ??= this.loadDisk()
    return this.diskLoadPromise
  }

  private async loadDisk(): Promise<void> {
    try {
      const cacheStat = await this.statImpl(this.cachePath)
      if (cacheStat.size > MAX_CACHE_BYTES) {
        throw new Error('registry cache exceeds disk size limit')
      }
      const encoded = await this.readFileImpl(this.cachePath)
      if (Buffer.byteLength(encoded, 'utf8') > MAX_CACHE_BYTES) {
        throw new Error('registry cache exceeds disk size limit')
      }
      const envelope = CacheEnvelopeSchema.parse(JSON.parse(encoded))
      const file = RegistryFileSchema.parse(envelope.raw)
      this.cache = { ...envelope, file }
    } catch {
      // Missing, legacy, oversized, corrupt, or schema-invalid cache. Keeping
      // the state empty also guarantees that the next request is unconditional.
      this.cache = null
    }
  }

  private async persist(): Promise<void> {
    if (!this.cache) return
    const envelope: CacheEnvelope = {
      cacheFormat: 2,
      etag: this.cache.etag,
      fetchedAt: this.cache.fetchedAt,
      raw: this.cache.raw,
    }
    try {
      await writeFileAtomic(this.cachePath, JSON.stringify(envelope))
    } catch (error) {
      this.log.warn({ error }, 'failed to persist registry cache')
    }
  }
}
