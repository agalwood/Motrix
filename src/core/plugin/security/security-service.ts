import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import { PLUGIN_SECURITY_TRUST } from '@shared/plugin-security-trust'
import {
  PLUGIN_SECURITY_FRESHNESS_MS,
  PLUGIN_SECURITY_INTERVAL_MS,
  PLUGIN_SECURITY_MAX_BYTES,
  type PluginSecurityDecision,
  type PluginSecurityIdentity,
  type PluginSecurityPolicy,
} from '@shared/schemas/plugin-security'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import {
  assertPolicyTransition,
  matchingAdvisories,
  verifySecurityPolicy,
} from './policy-verifier'

const log = getLogger('plugin:security')
const CACHE_LIMIT = PLUGIN_SECURITY_MAX_BYTES * 2
const RETRY_MS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000]
const CacheSchema = z
  .object({
    version: z.literal(1),
    envelope: z.string().nullable(),
    checkedAt: z.number().nonnegative(),
    nextCheckAt: z.number().nonnegative(),
    failures: z.number().int().nonnegative().max(100),
    etag: z.string().max(512).nullable(),
  })
  .strict()

export interface PluginSecurityServiceOptions {
  cachePath: string
  /** Only tests/embedders inject trust; production uses the pinned build. */
  trust?: typeof PLUGIN_SECURITY_TRUST
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
  writeCache?: (file: string, contents: string) => Promise<void>
}

/** One scheduler per host. Guest admission never performs network IO. */
export class PluginSecurityService {
  private readonly trust: typeof PLUGIN_SECURITY_TRUST
  private readonly now: () => number
  private readonly random: () => number
  private policy?: PluginSecurityPolicy
  private envelope: string | null = null
  private checkedAt = 0
  private nextCheckAt = 0
  private failures = 0
  private etag: string | null = null
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private integrityFailure = false
  private storageFailure = false
  private initialized?: Promise<void>
  private inflight?: Promise<void>
  private controller?: AbortController
  private timer?: NodeJS.Timeout
  private started = false
  private stopped = false
  private readonly listeners = new Set<() => void | Promise<void>>()
  private readonly decisions = new Map<
    string,
    PluginSecurityDecision | undefined
  >()

  constructor(private readonly options: PluginSecurityServiceOptions) {
    this.trust = options.trust ?? PLUGIN_SECURITY_TRUST
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  get configured(): boolean {
    return this.trust.publicKeys.length > 0
  }

  initialize(): Promise<void> {
    this.initialized ??= this.load()
    return this.initialized
  }

  private async load(): Promise<void> {
    if (!this.configured) return
    if (this.trust.baseline) {
      this.policy = verifySecurityPolicy(
        this.trust.baseline,
        this.trust.publicKeys
      )
      this.envelope = this.trust.baseline
    }
    try {
      if ((await stat(this.options.cachePath)).size > CACHE_LIMIT)
        throw new Error('Oversized policy cache')
      const saved = CacheSchema.parse(
        JSON.parse(await readFile(this.options.cachePath, 'utf8'))
      )
      if (saved.envelope) {
        const cached = verifySecurityPolicy(
          saved.envelope,
          this.trust.publicKeys
        )
        if (!this.policy || cached.revision >= this.policy.revision) {
          assertPolicyTransition(this.policy, cached)
          this.policy = cached
          this.envelope = saved.envelope
          this.checkedAt = saved.checkedAt
          this.etag = saved.etag
        } else {
          assertPolicyTransition(cached, this.policy)
        }
      }
      const now = this.now()
      this.nextCheckAt = Math.min(
        saved.nextCheckAt,
        now + PLUGIN_SECURITY_FRESHNESS_MS
      )
      this.failures = saved.failures
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.integrityFailure = true
        log.warn(
          { err: error },
          'security cache rejected; plugin admission closed until recovery'
        )
      }
    }
  }

  isFresh(): boolean {
    if (!this.configured) return true
    const age = this.now() - this.checkedAt
    return (
      !this.integrityFailure &&
      !this.storageFailure &&
      this.checkedAt > 0 &&
      age >= 0 &&
      age <= PLUGIN_SECURITY_FRESHNESS_MS &&
      !!this.policy &&
      Date.parse(this.policy.expiresAt) > this.now()
    )
  }

  decision(
    identity: PluginSecurityIdentity
  ): PluginSecurityDecision | undefined {
    if (!this.configured) return undefined
    if (this.integrityFailure)
      return { blocked: true, reason: 'unavailable', advisoryIds: [] }
    const key = JSON.stringify([
      identity.pluginId,
      identity.version,
      identity.archiveSha256,
    ])
    if (this.decisions.has(key)) return this.decisions.get(key)
    const advisories = this.policy
      ? matchingAdvisories(this.policy, identity)
      : []
    const first = advisories[0]
    const decision: PluginSecurityDecision | undefined = first
      ? {
          blocked: true,
          reason: first.reason,
          advisoryIds: advisories.map((entry) => entry.id),
          fixedVersion: first.fixedVersion,
          url: first.url,
        }
      : undefined
    // Bounded even when an installation source submits many distinct versions.
    if (this.decisions.size >= 2048) this.decisions.clear()
    this.decisions.set(key, decision)
    return decision
  }

  assertAllowed(identity: PluginSecurityIdentity): void {
    if (this.decision(identity))
      throw new AppError(
        ErrorCode.PluginSecurityBlocked,
        'plugins.security.blocked'
      )
  }

  subscribe(listener: () => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async notify(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.listeners].map((listener) => {
        try {
          return Promise.resolve(listener())
        } catch (error) {
          return Promise.reject(error)
        }
      })
    )
    for (const result of results)
      if (result.status === 'rejected') {
        log.error(
          { err: result.reason },
          'security policy enforcement failed; admission remains closed'
        )
      }
  }

  start(): void {
    if (!this.configured || this.started || this.stopped) return
    this.started = true
    this.schedule()
  }

  notifyWake(): void {
    if (this.now() >= this.nextCheckAt) this.schedule()
  }

  private schedule(): void {
    if (!this.started || this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    // A due startup/resume check is spread over 5–30 seconds.
    const delay =
      this.nextCheckAt > this.now()
        ? this.nextCheckAt - this.now()
        : 5_000 + this.random() * 25_000
    this.timer = setTimeout(() => {
      void this.refresh()
    }, delay)
    this.timer.unref?.()
  }

  /** Coalesced refresh. Force is rate-limited to one attempt per minute. */
  refresh(force = false): Promise<void> {
    if (!this.configured || this.stopped) return Promise.resolve()
    if (this.inflight) return this.inflight
    this.inflight = this.initialize()
      .then(async () => {
        const now = this.now()
        if (
          now - this.lastAttemptAt < 60_000 ||
          (!force && now < this.nextCheckAt)
        )
          return
        this.lastAttemptAt = now
        await this.fetchPolicy()
      })
      .finally(() => {
        this.inflight = undefined
        this.schedule()
      })
    return this.inflight
  }

  /** Installation can request a refresh without bypassing backoff. */
  async refreshIfStale(): Promise<void> {
    await this.initialize()
    if (
      this.now() - this.checkedAt >= PLUGIN_SECURITY_INTERVAL_MS ||
      !this.isFresh()
    )
      await this.refresh()
  }

  private async fetchPolicy(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    let deadline: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort()
        reject(new Error('Security policy timeout'))
      }, 5_000)
      deadline.unref?.()
    })
    let retryAfter = 0
    try {
      const url = new URL(this.trust.url)
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid security policy URL')
      const download = async () => {
        // Public static object: no installed-plugin inventory, credentials, or
        // per-plugin query parameters. The CDN owns HTTP cache revalidation.
        const response = await (this.options.fetchImpl ?? fetch)(url, {
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          headers: {
            accept: 'application/json',
            ...(this.etag ? { 'if-none-match': this.etag } : {}),
          },
        })
        if (response.status === 304 && this.envelope)
          return { raw: this.envelope, etag: this.etag }
        if (!response.ok) {
          const header = response.headers.get('retry-after')
          const requested =
            header && /^\d+$/.test(header)
              ? Number(header) * 1000
              : header
                ? Date.parse(header) - this.now()
                : 0
          retryAfter = Number.isFinite(requested)
            ? Math.min(Math.max(0, requested), PLUGIN_SECURITY_FRESHNESS_MS)
            : 0
          await response.body?.cancel()
          throw new Error(`Security feed HTTP ${response.status}`)
        }
        if (
          Number(response.headers.get('content-length')) >
          PLUGIN_SECURITY_MAX_BYTES
        ) {
          await response.body?.cancel()
          throw new Error('Security feed exceeds size limit')
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Empty security feed')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > PLUGIN_SECURITY_MAX_BYTES)
              throw new Error('Security feed exceeds size limit')
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
        const etag = response.headers.get('etag')
        return {
          raw: Buffer.concat(chunks).toString('utf8'),
          etag: etag && etag.length <= 512 ? etag : null,
        }
      }
      const { raw, etag } = await Promise.race([download(), timeout])
      if (this.stopped) return
      const next = verifySecurityPolicy(raw, this.trust.publicKeys)
      const now = this.now()
      if (
        Date.parse(next.issuedAt) > now + 5 * 60_000 ||
        Date.parse(next.expiresAt) <= now
      )
        throw new Error('Security feed is expired or from the future')
      assertPolicyTransition(this.policy, next)
      const changed = this.envelope !== raw || this.integrityFailure
      this.policy = next
      this.envelope = raw
      this.etag = etag
      this.integrityFailure = false
      this.decisions.clear()
      this.checkedAt = now
      this.storageFailure = true
      this.failures = 0
      this.nextCheckAt = now + this.jitter(PLUGIN_SECURITY_INTERVAL_MS)
      // Notify synchronously up to each listener's first await: admission is
      // closed before cache IO or worker teardown. Never roll back this policy
      // when storage or teardown fails.
      const enforcement = changed ? this.notify() : Promise.resolve()
      try {
        await this.persist()
        this.storageFailure = false
      } catch (error) {
        this.storageFailure = true
        throw error
      } finally {
        await enforcement
      }
      // Pending first activations can become available after a durable refresh.
      await this.notify()
    } catch (error) {
      if (this.stopped) return
      this.failures = Math.min(100, this.failures + 1)
      this.nextCheckAt =
        this.now() +
        Math.max(
          retryAfter,
          this.jitter(
            RETRY_MS[Math.min(this.failures - 1, RETRY_MS.length - 1)]
          )
        )
      log.warn(
        { err: error },
        'security refresh failed; retaining known blocks'
      )
      try {
        await this.persist()
      } catch (persistError) {
        this.storageFailure = true
        log.error(
          { err: persistError },
          'security policy cache could not be persisted'
        )
      }
    } finally {
      if (deadline) clearTimeout(deadline)
      controller.abort()
      if (this.controller === controller) this.controller = undefined
    }
  }

  private jitter(duration: number): number {
    return Math.round(duration * (0.9 + this.random() * 0.2))
  }

  private async persist(): Promise<void> {
    if (this.integrityFailure)
      throw new Error(
        'Cannot replace rejected security cache without a trusted refresh'
      )
    await mkdir(path.dirname(this.options.cachePath), { recursive: true })
    const contents = JSON.stringify({
      version: 1,
      envelope: this.envelope,
      checkedAt: this.checkedAt,
      nextCheckAt: this.nextCheckAt,
      failures: this.failures,
      etag: this.etag,
    })
    if (this.options.writeCache)
      await this.options.writeCache(this.options.cachePath, contents)
    else
      await writeFileAtomic(this.options.cachePath, contents, { mode: 0o600 })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort()
    await this.inflight
    this.listeners.clear()
  }
}
