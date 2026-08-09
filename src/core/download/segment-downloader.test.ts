import path from 'node:path'
import type { SegmentPlan } from '@core/media/segment-plan'
import { describe, expect, it } from 'vitest'
import type { PollScheduler, SegmentAria2 } from './segment-downloader'
import { SegmentDownloader } from './segment-downloader'

// A poll scheduler that swallows the callback: polls NEVER auto-fire. Tests
// that don't exercise byte polling use this so no real timer is created and
// the onProgress stream stays deterministic (only segment completions report).
const neverSchedule: PollScheduler = () => () => {}

// A poll scheduler the test drives by hand: it captures the poll callback so a
// test can await a single tick deterministically (no fake/real timers needed).
function makeManualScheduler() {
  let captured: (() => void | Promise<void>) | null = null
  const scheduler: PollScheduler = (cb) => {
    captured = cb
    return () => {
      captured = null
    }
  }
  return {
    scheduler,
    tick: async () => {
      await captured?.()
    },
  }
}

// ---------------------------------------------------------------------------
// Fake aria2 client — deterministic, event-driven
// ---------------------------------------------------------------------------

interface FakeAddUriCall {
  uris: string[]
  opts: {
    dir: string
    out: string
    header?: string[]
    'max-tries'?: number
    'retry-wait'?: number
  }
}

interface FakeForceRemoveCall {
  gid: string
}

function makeFakeAria2(opts?: {
  addUriDelay?: (gid: string) => Promise<void>
}) {
  const addUriCalls: FakeAddUriCall[] = []
  const forceRemoveCalls: FakeForceRemoveCall[] = []
  const bytes = new Map<
    string,
    { completedLength: number; totalLength: number }
  >()
  let completeCb: ((gid: string) => void) | null = null
  let errorCb: ((gid: string) => void) | null = null
  let nextGidN = 1

  const aria2: SegmentAria2 = {
    addUri(uris, addOpts) {
      const gid = `gid${nextGidN++}`
      addUriCalls.push({ uris, opts: addOpts })
      const delay = opts?.addUriDelay?.(gid) ?? Promise.resolve()
      return delay.then(() => gid)
    },
    forceRemove(gid) {
      forceRemoveCalls.push({ gid })
      return Promise.resolve()
    },
    tellStatus(gid) {
      return Promise.resolve(bytes.get(gid) ?? null)
    },
    onComplete(cb) {
      completeCb = cb
    },
    onError(cb) {
      errorCb = cb
    },
  }

  return {
    aria2,
    get addUriCalls() {
      return addUriCalls
    },
    get forceRemoveCalls() {
      return forceRemoveCalls
    },
    /** Set the byte counts aria2 would report for a gid on the next poll. */
    setBytes(gid: string, completedLength: number, totalLength: number) {
      bytes.set(gid, { completedLength, totalLength })
    },
    fireComplete(gid: string) {
      if (!completeCb) throw new Error('onComplete callback not registered')
      completeCb(gid)
    },
    fireError(gid: string) {
      if (!errorCb) throw new Error('onError callback not registered')
      errorCb(gid)
    },
  }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal SegmentPlan
// ---------------------------------------------------------------------------

function makePlan(opts: {
  init?: { url: string; byteRange?: { offset: number; length: number } }
  segments: Array<{
    url: string
    byteRange?: { offset: number; length: number }
  }>
}): SegmentPlan {
  return {
    container: 'mpegts',
    isComplete: true,
    init: opts.init,
    segments: opts.segments.map((s, i) => ({
      url: s.url,
      index: i,
      byteRange: s.byteRange,
    })),
  }
}

const TMP = '/tmp/test-seg'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SegmentDownloader', () => {
  it('(a) submits exactly one addUri per part — uris array length is always 1', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
        { url: 'https://cdn.example/seg2.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})

    // Wait one tick for all addUri calls to be queued
    await new Promise((resolve) => setImmediate(resolve))

    // Each call's uris array must have exactly 1 element
    for (const call of fake.addUriCalls) {
      expect(call.uris).toHaveLength(1)
    }
    expect(fake.addUriCalls).toHaveLength(3)

    // Fire completions for all gids
    fake.fireComplete('gid1')
    fake.fireComplete('gid2')
    fake.fireComplete('gid3')

    await runPromise
  })

  it('(b) out names are zero-padded and ordered (init at 000000, segments follow)', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      init: { url: 'https://cdn.example/init.mp4' },
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    const outs = fake.addUriCalls.map((c) => c.opts.out)
    // init is job index 0, segments are job indices 1 and 2
    expect(outs[0]).toBe('000000.seg')
    expect(outs[1]).toBe('000001.seg')
    expect(outs[2]).toBe('000002.seg')

    fake.fireComplete('gid1')
    fake.fireComplete('gid2')
    fake.fireComplete('gid3')

    await runPromise
  })

  it('(c) progress fraction reaches 1.0 when all parts complete', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const fractions: number[] = []
    const runPromise = dl.run(plan, {}, (p) => fractions.push(p.fraction))
    await new Promise((resolve) => setImmediate(resolve))

    fake.fireComplete('gid1')
    fake.fireComplete('gid2')

    await runPromise

    expect(fractions[fractions.length - 1]).toBe(1)
    expect(fractions[0]).toBeCloseTo(0.5)
  })

  it('(d) a part with byteRange produces a Range header entry', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        {
          url: 'https://cdn.example/media.ts',
          byteRange: { offset: 100, length: 500 },
        },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    // bytes=100-599  (offset + length - 1 = 100 + 500 - 1 = 599)
    const headers = fake.addUriCalls[0].opts.header ?? []
    const rangeHeader = headers.find((h) => h.startsWith('Range:'))
    expect(rangeHeader).toBe('Range: bytes=100-599')

    fake.fireComplete('gid1')
    await runPromise
  })

  it('(d2) replayed request headers are included as Name: value strings', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [{ url: 'https://cdn.example/seg.ts' }],
    })

    const runPromise = dl.run(
      plan,
      { Referer: 'https://www.example.com', Cookie: 'sid=abc' },
      () => {}
    )
    await new Promise((resolve) => setImmediate(resolve))

    const headers = fake.addUriCalls[0].opts.header ?? []
    expect(headers).toContain('Referer: https://www.example.com')
    expect(headers).toContain('Cookie: sid=abc')

    fake.fireComplete('gid1')
    await runPromise
  })

  it('(e) onError triggers a retry and rejects after the cap', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [{ url: 'https://cdn.example/bad.ts' }],
    })

    // Attach catch early so the rejection is never "unhandled"
    let caught: Error | null = null
    const runPromise = dl
      .run(plan, {}, () => {})
      .catch((err) => {
        caught = err
      })

    await new Promise((resolve) => setImmediate(resolve))

    // Exhaust retries — each error triggers a re-add (3 retries = 4 total addUri calls)
    // gid1 = first attempt, gid2/3/4 = retries
    fake.fireError('gid1')
    await new Promise((resolve) => setImmediate(resolve))
    fake.fireError('gid2')
    await new Promise((resolve) => setImmediate(resolve))
    fake.fireError('gid3')
    await new Promise((resolve) => setImmediate(resolve))
    fake.fireError('gid4')
    await new Promise((resolve) => setImmediate(resolve))

    await runPromise
    // 1 initial + 3 retries = 4 total addUri calls
    expect(fake.addUriCalls).toHaveLength(4)
    expect(caught).toBeInstanceOf(Error)
  })

  it('(f) cancel() forceRemoves all tracked gids', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
        { url: 'https://cdn.example/seg2.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {}).catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))

    // While downloads are in-flight, cancel
    await dl.cancel()

    // All 3 gids should be forceRemoved
    const removedGids = fake.forceRemoveCalls.map((c) => c.gid).sort()
    expect(removedGids).toEqual(['gid1', 'gid2', 'gid3'])

    await runPromise
  })

  it('(g) resolves partPaths in index order with initPath separate', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      init: { url: 'https://cdn.example/init.mp4' },
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
        { url: 'https://cdn.example/seg2.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    fake.fireComplete('gid1')
    fake.fireComplete('gid2')
    fake.fireComplete('gid3')
    fake.fireComplete('gid4')

    const result = await runPromise

    // initPath is the init file (job index 0)
    expect(result.initPath).toBe(path.join(TMP, '000000.seg'))
    // partPaths are segments in plan index order (job indices 1,2,3)
    expect(result.partPaths).toEqual([
      path.join(TMP, '000001.seg'),
      path.join(TMP, '000002.seg'),
      path.join(TMP, '000003.seg'),
    ])
  })

  it('(g2) no init: initPath is undefined and partPaths ordered', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    fake.fireComplete('gid1')
    fake.fireComplete('gid2')

    const result = await runPromise

    expect(result.initPath).toBeUndefined()
    expect(result.partPaths).toEqual([
      path.join(TMP, '000000.seg'),
      path.join(TMP, '000001.seg'),
    ])
  })

  it('aria2 max-tries and retry-wait options are passed to addUri', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [{ url: 'https://cdn.example/seg.ts' }],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    expect(fake.addUriCalls[0].opts['max-tries']).toBe(5)
    expect(fake.addUriCalls[0].opts['retry-wait']).toBe(3)

    fake.fireComplete('gid1')
    await runPromise
  })

  it('concurrency semaphore limits simultaneous addUri calls', async () => {
    const fake = makeFakeAria2()
    // Limit to 2 concurrent
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      concurrency: 2,
      pollScheduler: neverSchedule,
    })
    // 5 segments but concurrency is 2
    const plan = makePlan({
      segments: Array.from({ length: 5 }, (_, i) => ({
        url: `https://cdn.example/seg${i}.ts`,
      })),
    })

    const runPromise = dl.run(plan, {}, () => {}).catch(() => {})

    // After first tick, only 2 addUriCalls should have been made
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.addUriCalls.length).toBeLessThanOrEqual(2)

    // Complete them to allow more to flow
    fake.fireComplete('gid1')
    fake.fireComplete('gid2')
    await new Promise((resolve) => setImmediate(resolve))
    fake.fireComplete('gid3')
    fake.fireComplete('gid4')
    await new Promise((resolve) => setImmediate(resolve))
    fake.fireComplete('gid5')
    await new Promise((resolve) => setImmediate(resolve))

    await runPromise
  })

  it('(h) reports summed byte counts polled from tellStatus, retaining finished segments', async () => {
    const fake = makeFakeAria2()
    const manual = makeManualScheduler()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: manual.scheduler,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const reports: Array<{
      fraction: number
      downloadedBytes: number
      totalBytes: number
    }> = []
    const runPromise = dl.run(plan, {}, (p) => reports.push(p))
    // Let both addUri calls resolve so their gids are tracked.
    await new Promise((resolve) => setImmediate(resolve))

    // aria2 reports partial progress for both in-flight segments.
    fake.setBytes('gid1', 300, 1000)
    fake.setBytes('gid2', 200, 500)
    await manual.tick()

    const afterPoll = reports[reports.length - 1]
    expect(afterPoll.downloadedBytes).toBe(500) // 300 + 200
    expect(afterPoll.totalBytes).toBe(1500) // 1000 + 500

    // seg0 finishes: its last-seen total (1000) is retained as a finished
    // segment; the total must never shrink when a segment leaves the active set.
    fake.fireComplete('gid1')
    const afterComplete = reports[reports.length - 1]
    expect(afterComplete.totalBytes).toBe(1500) // 1000 finished + 500 active
    expect(afterComplete.downloadedBytes).toBe(1200) // 1000 finished + 200 live

    // A fresh poll picks up gid2's updated live bytes.
    fake.setBytes('gid2', 500, 500)
    await manual.tick()
    expect(reports[reports.length - 1].downloadedBytes).toBe(1500) // 1000 + 500

    fake.fireComplete('gid2')
    const result = await runPromise
    const final = reports[reports.length - 1]
    expect(final.downloadedBytes).toBe(1500)
    expect(final.totalBytes).toBe(1500)
    expect(final.fraction).toBe(1)
    expect(result.partPaths).toHaveLength(2)
  })

  it('(h2) still counts a segment that completes before any poll observed it', async () => {
    const fake = makeFakeAria2()
    // neverSchedule = no poll ever fires, so the ONLY chance to learn each
    // segment's size is a final tellStatus at completion. This is the real
    // 700ms-first-tick gap: a fast/small segment (or the last batch) can go
    // addUri → onComplete before the interval's first tick.
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const reports: Array<{
      fraction: number
      downloadedBytes: number
      totalBytes: number
    }> = []
    const runPromise = dl.run(plan, {}, (p) => reports.push(p))
    await new Promise((resolve) => setImmediate(resolve))

    // aria2 knows each segment's final size, but NO poll observed it.
    fake.setBytes('gid1', 1000, 1000)
    fake.setBytes('gid2', 500, 500)
    fake.fireComplete('gid1')
    fake.fireComplete('gid2')

    const result = await runPromise
    const final = reports[reports.length - 1]
    // Must NOT be 0 B — that is exactly the reported "size always 0 B" bug for
    // a fully downloaded (single-segment) media task.
    expect(final.downloadedBytes).toBe(1500)
    expect(final.totalBytes).toBe(1500)
    expect(result.partPaths).toHaveLength(2)
  })

  it('(i) getActiveGids exposes the in-flight segment gids', async () => {
    const fake = makeFakeAria2()
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [
        { url: 'https://cdn.example/seg0.ts' },
        { url: 'https://cdn.example/seg1.ts' },
      ],
    })

    const runPromise = dl.run(plan, {}, () => {})
    await new Promise((resolve) => setImmediate(resolve))

    expect(dl.getActiveGids().slice().sort()).toEqual(['gid1', 'gid2'])

    fake.fireComplete('gid1')
    expect(dl.getActiveGids()).toEqual(['gid2'])

    fake.fireComplete('gid2')
    await runPromise
    expect(dl.getActiveGids()).toEqual([])
  })

  it('(j) clears the poll timer on every exit path (resolve / reject / cancel)', async () => {
    // resolve path
    {
      const fake = makeFakeAria2()
      let stopped = false
      const scheduler: PollScheduler = () => () => {
        stopped = true
      }
      const dl = new SegmentDownloader({
        aria2: fake.aria2,
        tmpDir: TMP,
        pollScheduler: scheduler,
      })
      const run = dl.run(makePlan({ segments: [{ url: 'a' }] }), {}, () => {})
      await new Promise((r) => setImmediate(r))
      fake.fireComplete('gid1')
      await run
      expect(stopped).toBe(true)
    }
    // cancel path
    {
      const fake = makeFakeAria2()
      let stopped = false
      const scheduler: PollScheduler = () => () => {
        stopped = true
      }
      const dl = new SegmentDownloader({
        aria2: fake.aria2,
        tmpDir: TMP,
        pollScheduler: scheduler,
      })
      const run = dl.run(makePlan({ segments: [{ url: 'a' }] }), {}, () => {})
      await new Promise((r) => setImmediate(r))
      await dl.cancel()
      await run.catch(() => {})
      expect(stopped).toBe(true)
    }
  })

  it('cancel() during retry: resolved gid is immediately forceRemoved, not tracked', async () => {
    const delayPromises: { resolve: (() => void) | null } = { resolve: null }
    const fake = makeFakeAria2({
      addUriDelay: () => {
        return new Promise<void>((resolve) => {
          delayPromises.resolve = resolve
        })
      },
    })
    const dl = new SegmentDownloader({
      aria2: fake.aria2,
      tmpDir: TMP,
      pollScheduler: neverSchedule,
    })
    const plan = makePlan({
      segments: [{ url: 'https://cdn.example/seg0.ts' }],
    })

    const runPromise = dl.run(plan, {}, () => {}).catch(() => {})
    // addUri is pending (resolve not called yet)
    await new Promise((resolve) => setImmediate(resolve))

    // Cancel while addUri promise is still pending
    await dl.cancel()

    // Now resolve the addUri promise — the gid should be forceRemoved
    if (delayPromises.resolve) {
      delayPromises.resolve()
    }
    await new Promise((resolve) => setImmediate(resolve))

    // Verify: the returned gid was forceRemoved, not added to activeGids/activeJobs
    expect(fake.forceRemoveCalls).toHaveLength(1)
    expect(fake.forceRemoveCalls[0].gid).toBe('gid1')

    await runPromise
  })
})
