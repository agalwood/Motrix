// REAL end-to-end mux download: local HTTP server → bundled aria2c (real
// download) → SegmentAssembler → real ffmpeg mux → playable mp4. This is the
// operational proof of the resolve→download→mux path (the bilibili/youtube
// `mux` selection) with NO fakes at the download/ffmpeg boundary — it would
// have caught the saveDir-ENOENT, fmp4/single ext, and dispatch wiring bugs.
//
// Gated: skips unless the bundled aria2c, a bindable loopback, AND ffmpeg/
// ffprobe are present (so CI without those artifacts skips cleanly).

import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { TaskStatus } from '@shared/types/task'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '../../test-utils/aria2'
import { Aria2SegmentClient } from '../download/aria2-segment-client'
import { SegmentDownloader } from '../download/segment-downloader'
import { FfmpegService } from '../ffmpeg/ffmpeg-service'
import { assembleSegments } from '../media/segment-assembler'
import { SegmentDecryptor } from '../media/segment-decryptor'
import { type MediaJob, MediaTaskCoordinator } from './media-task-coordinator'
import { TaskManager } from './task-manager'

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' })
  const p = r.status === 0 ? r.stdout.trim() : ''
  return p && existsSync(p) ? p : null
}

const FFMPEG = which('ffmpeg')
const FFPROBE = which('ffprobe')

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  intervalMs = 200
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe.skipIf(
  !bundledAria2Exists() || !canBindLoopbackTcp() || !FFMPEG || !FFPROBE
)('media mux E2E (real aria2 + real ffmpeg)', () => {
  let fixturesDir: string
  let aria2BaseDir: string
  let outRoot: string
  let server: Server
  let baseUrl: string
  let handle: Aria2Handle
  let rpc: import('../engine/aria2/aria2-rpc-client').Aria2RpcClient
  let disconnect: () => void

  beforeAll(async () => {
    fixturesDir = mkdtempSync(path.join(tmpdir(), 'mux-fix-'))
    outRoot = mkdtempSync(path.join(tmpdir(), 'mux-out-'))
    // 1s video-only (h264/mp4) + 1s audio-only (aac/m4a) — separate streams,
    // exactly the bilibili/youtube adaptive shape that must be muxed.
    execFileSync(FFMPEG as string, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=15',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(fixturesDir, 'video.mp4'),
    ])
    execFileSync(FFMPEG as string, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:a',
      'aac',
      path.join(fixturesDir, 'audio.m4a'),
    ])

    server = createServer((req, res) => {
      const name = path.basename(req.url ?? '')
      const file = path.join(fixturesDir, name)
      if (!existsSync(file)) {
        res.statusCode = 404
        res.end('nope')
        return
      }
      createReadStream(file).pipe(res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`

    aria2BaseDir = mkdtempSync(path.join(tmpdir(), 'mux-a2-'))
    handle = await spawnAria2ForTest({ baseDir: aria2BaseDir })
    const wired = await connectAdapter(handle)
    rpc = wired.rpc
    disconnect = wired.disconnect
  }, 60_000)

  afterAll(async () => {
    try {
      disconnect?.()
    } catch {
      /* tolerate broken socket */
    }
    await handle?.kill()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    for (const d of [fixturesDir, aria2BaseDir, outRoot]) {
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  it('downloads video+audio over aria2 and muxes to a playable mp4 (saveDir auto-created)', async () => {
    const segmentClient = new Aria2SegmentClient(rpc)
    const taskManager = new TaskManager()
    const coordinator = new MediaTaskCoordinator({
      taskManager,
      activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
      eventBus: { emit() {} },
      publishTaskUpdate: () => {},
      publishTaskUpdateNow: () => {},
      resolveFfmpegBinaryPath: async () => FFMPEG as string,
      makeDownloader: (tmpDir) =>
        new SegmentDownloader({ aria2: segmentClient, tmpDir }),
      decryptor: new SegmentDecryptor(),
      assemble: assembleSegments,
      makeFfmpeg: () => new FfmpegService(),
      persist: async () => {},
      mkdtemp: () => fsp.mkdtemp(path.join(tmpdir(), 'mux-tmp-')),
      // Fresh tmpdir per run — no collisions, identity pick suffices.
      pickName: async (_dir, desired) => desired,
    })

    // Deliberately NON-existent nested saveDir → exercises the saveDir mkdir
    // fix; without it ffmpeg ENOENTs on the final write.
    const saveDir = path.join(outRoot, 'does', 'not', 'exist', 'yet')
    const job: MediaJob = {
      video: {
        container: 'single',
        segments: [{ url: `${baseUrl}/video.mp4`, index: 0 }],
        isComplete: true,
      },
      audio: {
        container: 'single',
        segments: [{ url: `${baseUrl}/audio.m4a`, index: 0 }],
        isComplete: true,
      },
      headers: {},
      saveDir,
      finalName: 'out.mp4',
      sourceMeta: null,
      kind: 'mux',
    }

    const { taskId } = await coordinator.start(job)
    await waitFor(
      () => taskManager.getById(taskId)?.status === TaskStatus.Completed,
      45_000
    )

    const out = path.join(saveDir, 'out.mp4')
    expect(existsSync(out)).toBe(true)
    // The .motrix placeholder must be renamed away — no residue after finalize.
    expect(existsSync(`${out}.motrix`)).toBe(false)

    // The muxed file must contain BOTH a video and an audio stream.
    const probe = execFileSync(FFPROBE as string, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      out,
    ]).toString()
    expect(probe).toContain('video')
    expect(probe).toContain('audio')
  }, 60_000)
})
