import { join } from 'node:path'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { type Browser, makeSessionKey } from '@shared/protocol/bridge'
import type { BridgeSourceMeta, SourceMeta } from '@shared/types/task'
import { writeCookieJar } from './cookie-jar'
import { BridgeReceiverError } from './errors'
import { stripHopByHopHeaders } from './header-replay'
import { ensureMediaExtension } from './pipelines/media-final-name'

export interface AdapterDeps {
  /** Root for cookie jars: <userData>/bridge-receiver. */
  dataDir: string
  /** appSettings.defaultSaveDir; used when client did not specify saveDir. */
  defaultSaveDir: string
  /** FinalNamePicker shim — wraps existing picker so tests can stub. */
  pickName: (saveDir: string, desired: string) => Promise<string>
  /** newTaskId injection — defaults to a uuid mint in production wiring. */
  mintTaskId: () => string
}

export interface AdaptedDirect {
  taskId: string
  saveDir: string
  finalName: string
  kind: 'direct'
  primaryUrl: string
  sanitizedHeaders: Record<string, string>
  jarPath: string
  sourceMeta: BridgeSourceMeta
  pageUrl: string
}

export interface AdaptedMagnet {
  kind: 'magnet'
  saveDir: string
  uri: string
  sourceMeta: BridgeSourceMeta
}

export interface AdaptedHls {
  kind: 'hls'
  taskId: string
  saveDir: string
  finalName: string
  manifestUrl: string
  sanitizedHeaders: Record<string, string>
  container: 'mp4' | 'mkv' | 'ts'
  sourceMeta: BridgeSourceMeta
  durationSec?: number
}

export interface AdaptedDash extends Omit<AdaptedHls, 'kind' | 'container'> {
  kind: 'dash'
  container: 'mp4' | 'mkv'
}

export interface AdaptedMux {
  kind: 'mux'
  taskId: string
  saveDir: string
  finalName: string
  videoUrl: string
  audioUrl: string
  sanitizedHeaders: Record<string, string>
  container: 'mp4' | 'mkv'
  /** BridgeSourceMeta for bridge-originated mux tasks; null for desktop
   *  Add-Task path (where no extension session context exists). */
  sourceMeta: SourceMeta
  durationSec?: number
}

export interface AdaptInput {
  extensionId: string
  browser: Browser
}

/**
 * Pipeline-agnostic preprocessing for SubmitDownload payloads (spec §3.1).
 */
export class SubmitDownloadAdapter {
  constructor(private readonly deps: AdapterDeps) {}

  async adapt(
    params: DownloadSubmitParams,
    input: AdaptInput
  ): Promise<
    AdaptedDirect | AdaptedMagnet | AdaptedHls | AdaptedDash | AdaptedMux
  > {
    // Bootstrap already ran DownloadSubmitParamsSchema.safeParse() and threw
    // InvalidParams on failure. We have typed data here, but MDXP's
    // Resource.url is plain z.string() (not http-only), so we still need to
    // reject non-http(s) schemes as a business rule.
    if (
      params.selection.kind === 'direct' ||
      params.selection.kind === 'hls' ||
      params.selection.kind === 'dash'
    ) {
      const url = params.selection.primary.url
      if (!/^https?:\/\//i.test(url)) {
        throw new BridgeReceiverError(
          'invalid-url-scheme',
          'URL must be http: or https:'
        )
      }
    }
    if (params.selection.kind === 'mux') {
      for (const r of [params.selection.video, params.selection.audio]) {
        if (!/^https?:\/\//i.test(r.url)) {
          throw new BridgeReceiverError(
            'invalid-url-scheme',
            'URL must be http: or https:'
          )
        }
      }
    }

    const { selection, source, meta } = params

    if (selection.kind === 'magnet') {
      return {
        kind: 'magnet',
        saveDir: this.deps.defaultSaveDir,
        uri: selection.uri,
        sourceMeta: this.makeSourceMeta('magnet', input, source, meta),
      }
    }

    if (selection.kind === 'hls' || selection.kind === 'dash') {
      const taskId = this.deps.mintTaskId()
      // Append the container extension BEFORE the dedup pick — the picked
      // name must be the name that lands on disk, or the collision counter
      // is computed against a string that never exists.
      const finalName = await this.deps.pickName(
        this.deps.defaultSaveDir,
        ensureMediaExtension(
          sanitizeFilename(meta.suggestedFilename),
          selection.container
        )
      )
      const jarPath = join(this.deps.dataDir, 'cookies', `${taskId}.txt`)
      await writeCookieJar(jarPath, selection.primary.cookies)
      const sanitizedHeaders = stripHopByHopHeaders(selection.primary.headers)
      const base = {
        taskId,
        saveDir: this.deps.defaultSaveDir,
        finalName,
        manifestUrl: selection.primary.url,
        sanitizedHeaders,
        sourceMeta: this.makeSourceMeta(selection.kind, input, source, meta),
        ...(meta.durationSec != null ? { durationSec: meta.durationSec } : {}),
      }
      if (selection.kind === 'dash') {
        return {
          kind: 'dash',
          ...base,
          container: selection.container,
        }
      }
      return {
        kind: 'hls',
        ...base,
        container: selection.container,
      }
    }

    if (selection.kind === 'mux') {
      const taskId = this.deps.mintTaskId()
      // Same as hls/dash: extension first, then the dedup pick.
      const finalName = await this.deps.pickName(
        this.deps.defaultSaveDir,
        ensureMediaExtension(
          sanitizeFilename(meta.suggestedFilename),
          selection.container
        )
      )
      const jarPath = join(this.deps.dataDir, 'cookies', `${taskId}.txt`)
      await writeCookieJar(jarPath, [
        ...selection.video.cookies,
        ...selection.audio.cookies,
      ])
      return {
        kind: 'mux',
        taskId,
        saveDir: this.deps.defaultSaveDir,
        finalName,
        videoUrl: selection.video.url,
        audioUrl: selection.audio.url,
        sanitizedHeaders: stripHopByHopHeaders(selection.video.headers),
        container: selection.container,
        sourceMeta: this.makeSourceMeta('mux', input, source, meta),
        ...(meta.durationSec != null ? { durationSec: meta.durationSec } : {}),
      }
    }

    // selection.kind === 'direct'
    const primaryUrl = selection.primary.url
    const sanitized = sanitizeFilename(meta.suggestedFilename)
    const taskId = this.deps.mintTaskId()
    const saveDir = this.deps.defaultSaveDir
    const finalName = await this.deps.pickName(saveDir, sanitized)
    const sanitizedHeaders = stripHopByHopHeaders(selection.primary.headers)

    const jarPath = join(this.deps.dataDir, 'cookies', `${taskId}.txt`)
    await writeCookieJar(jarPath, selection.primary.cookies)

    return {
      taskId,
      saveDir,
      finalName,
      kind: 'direct',
      primaryUrl,
      sanitizedHeaders,
      jarPath,
      sourceMeta: this.makeSourceMeta('direct', input, source, meta),
      pageUrl: source.pageUrl,
    }
  }

  private makeSourceMeta(
    kind: BridgeSourceMeta['kind'],
    input: AdaptInput,
    source: DownloadSubmitParams['source'],
    meta: DownloadSubmitParams['meta']
  ): BridgeSourceMeta {
    const sessionKey = makeSessionKey(input.browser, input.extensionId)
    return {
      kind,
      extensionId: input.extensionId,
      browser: input.browser,
      sessionKey,
      pageUrl: source.pageUrl,
      pageTitle: source.pageTitle,
      qualityLabel: meta.qualityLabel,
      durationSec: meta.durationSec ?? null,
      submittedAt: Date.now(),
    }
  }
}

// Chars forbidden in cross-platform filenames: < > : " / \ | ? * and C0 controls (U+0000-U+001F).
// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids noControlCharactersInRegex
const FILENAME_BAD = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001F]', 'g')
const MAX_FILENAME = 200

export function sanitizeFilename(input: string): string {
  const cleaned = input.replace(FILENAME_BAD, '_')
  return cleaned.length > MAX_FILENAME
    ? cleaned.slice(0, MAX_FILENAME)
    : cleaned
}
