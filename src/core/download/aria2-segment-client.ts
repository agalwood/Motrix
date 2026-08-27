import type { SegmentAria2 } from './segment-downloader'

interface Aria2Event {
  gid: string
}

interface Aria2Rpc {
  addUri(
    uris: string[],
    options: Record<string, string | string[]>
  ): Promise<string>
  forceRemove(gid: string): Promise<unknown>
  // aria2 returns every numeric field as a string (JSON-RPC convention). We
  // only need the two byte counts, so pass an explicit key filter to keep the
  // response small. Typed structurally (not via Aria2RawStatus) so this file
  // stays free of engine/aria2 internal types.
  tellStatus(
    gid: string,
    keys?: string[]
  ): Promise<{ completedLength?: string; totalLength?: string }>
  onDownloadComplete(handler: (event: Aria2Event) => void): void
  onDownloadError(handler: (event: Aria2Event) => void): void
}

export class Aria2SegmentClient implements SegmentAria2 {
  private readonly rpc: Aria2Rpc
  private readonly completeCallbacks: Array<(gid: string) => void> = []
  private readonly errorCallbacks: Array<(gid: string) => void> = []
  private readonly active = new Set<string>()

  constructor(rpc: Aria2Rpc) {
    this.rpc = rpc
    rpc.onDownloadComplete((event) => {
      this.active.delete(event.gid)
      for (const cb of this.completeCallbacks) {
        cb(event.gid)
      }
    })
    rpc.onDownloadError((event) => {
      this.active.delete(event.gid)
      for (const cb of this.errorCallbacks) {
        cb(event.gid)
      }
    })
  }

  /** Returns true if this gid belongs to an active segment download. */
  isSegmentGid(gid: string): boolean {
    return this.active.has(gid)
  }

  onComplete(cb: (gid: string) => void): void {
    this.completeCallbacks.push(cb)
  }

  onError(cb: (gid: string) => void): void {
    this.errorCallbacks.push(cb)
  }

  async addUri(
    uris: string[],
    opts: {
      dir: string
      out: string
      header?: string[]
      'max-tries'?: number
      'retry-wait'?: number
    }
  ): Promise<string> {
    const options: Record<string, string | string[]> = {
      continue: 'false',
      dir: opts.dir,
      out: opts.out,
    }
    if (opts.header !== undefined) {
      options.header = opts.header
    }
    if (opts['max-tries'] !== undefined) {
      options['max-tries'] = String(opts['max-tries'])
    }
    if (opts['retry-wait'] !== undefined) {
      options['retry-wait'] = String(opts['retry-wait'])
    }
    const gid = await this.rpc.addUri(uris, options)
    this.active.add(gid)
    return gid
  }

  /**
   * In-progress byte counts for a single segment gid. Delegates to
   * aria2.tellStatus, requesting only the two length fields, and parses the
   * string values to numbers. Returns null on any RPC error, on an unknown
   * gid, or when a field is absent / non-numeric — callers treat null as "no
   * byte info for this gid this tick" and simply skip it.
   */
  async tellStatus(
    gid: string
  ): Promise<{ completedLength: number; totalLength: number } | null> {
    try {
      const raw = await this.rpc.tellStatus(gid, [
        'completedLength',
        'totalLength',
      ])
      const completedLength = Number(raw.completedLength)
      const totalLength = Number(raw.totalLength)
      if (!Number.isFinite(completedLength) || !Number.isFinite(totalLength)) {
        return null
      }
      return { completedLength, totalLength }
    } catch {
      return null
    }
  }

  async forceRemove(gid: string): Promise<void> {
    // Drop from the skip-set only AFTER aria2 has removed the download. If we
    // deleted first, the 1s poll loop could observe the gid still live in
    // aria2 but no longer in `active` and mint a phantom segment task — the
    // "a bunch of seg tasks appear right after the mux task errors" bug. The
    // dir-based suppression in the poll loop is the gid-timing-independent
    // backstop; this ordering closes the window at the source.
    try {
      await this.rpc.forceRemove(gid)
    } finally {
      this.active.delete(gid)
    }
  }
}
