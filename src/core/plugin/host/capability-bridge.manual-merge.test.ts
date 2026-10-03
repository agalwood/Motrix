// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FfmpegCapabilityHost,
  type FfmpegOpHandle,
} from '../capabilities/ffmpeg'
import type { CapabilityBridge, ManualMergeContext } from './capability-bridge'
import { makeStubCapabilityHost, spawnTestBridge } from './test-helpers'

const id = 'test.manual-merge'
const commandId = `${id}.mergeStreams`
const bundle = `import { commands, ffmpeg } from 'motrix:plugin-api';
commands.register('${commandId}', async (args) => {
  if (!ffmpeg.available) throw new Error('ffmpeg unavailable');
  if (args.probe) return await ffmpeg.probe({path: args.probe});
  if (args.transcode) return await (await ffmpeg.transcode({input: args.videoInput, output: args.output})).result;
  if (args.parallel) {
    const launches = await Promise.allSettled([ffmpeg.mergeStreams(args), ffmpeg.mergeStreams(args)]);
    for (const launch of launches) if (launch.status === 'fulfilled') await launch.value.result;
    return launches.map((launch) => launch.status);
  }
  await ffmpeg.probe({path: args.videoInput});
  await (await ffmpeg.mergeStreams(args)).result;
  return {outputPath: args.output};
});`

describe('manual merge through the real QuickJS worker', () => {
  let dir: string
  let bridge: CapabilityBridge | undefined
  let controller: AbortController
  let context: ManualMergeContext
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'merge-guest-'))
    controller = new AbortController()
    context = {
      videoInput: path.join(dir, 'video.mp4'),
      audioInput: path.join(dir, 'audio.m4a'),
      output: path.join(dir, 'merged.mp4'),
      signal: controller.signal,
      onProgress: vi.fn(),
    }
    await writeFile(
      path.join(dir, 'motrix-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id,
        name: 'Merger',
        version: '1.0.0',
        description: '',
        categories: ['post-action'],
        engines: { motrix: '*' },
        main: 'plugin.js',
        permissions: ['ffmpeg'],
        activationEvents: [`onCommand:${commandId}`],
        contributes: { commands: [{ id: commandId, title: 'Merge' }] },
      })
    )
    await writeFile(path.join(dir, 'plugin.js'), bundle)
  })
  afterEach(async () => {
    await bridge?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  async function start(ffmpeg: FfmpegCapabilityHost) {
    const host = makeStubCapabilityHost()
    host.ffmpeg = ffmpeg
    const spawned = await spawnTestBridge(dir, { capabilityHost: host })
    expect(spawned.errorCode).toBeUndefined()
    bridge = spawned.bridge
    return bridge
  }
  const fake = () => ({
    available: true,
    probe: vi.fn(async () => ({
      streams: [{ type: 'video' }],
      durationMs: 1000,
    })),
    mergeStreams: vi.fn(
      (): FfmpegOpHandle<{ outputPath: string }> => ({
        id: 'operation',
        result: Promise.resolve({ outputPath: '/output' }),
        abort: vi.fn(),
        progress: {
          async *[Symbol.asyncIterator]() {
            yield { percent: 50, timeMs: 500, speed: '1x' }
          },
        },
      })
    ),
  })

  it('forwards selected inputs, staging output, duration and progress', async () => {
    const ffmpeg = fake()
    const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
    const args = {
      videoInput: context.videoInput,
      audioInput: context.audioInput,
      output: context.output,
      expectedDurationMs: 1000,
    }
    await expect(
      guest.callMediaMerge(commandId, args, context)
    ).resolves.toEqual({ outputPath: context.output })
    expect(ffmpeg.mergeStreams).toHaveBeenCalledWith(
      expect.objectContaining({
        ...args,
        localOnly: true,
        signal: controller.signal,
      })
    )
    expect(context.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 50 })
    )
  })

  it('rejects generic invocation of the merger before probing or writing', async () => {
    const ffmpeg = fake()
    const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
    await expect(
      guest.callPlugin(commandId, {
        videoInput: context.videoInput,
        audioInput: context.audioInput,
        output: context.output,
      })
    ).rejects.toMatchObject({ code: 'plugin.command.access_denied' })
    expect(ffmpeg.probe).not.toHaveBeenCalled()
    expect(ffmpeg.mergeStreams).not.toHaveBeenCalled()
  })

  it('admits only one launch even when the command attempts two concurrently', async () => {
    const ffmpeg = fake()
    const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
    await expect(
      guest.callMediaMerge(
        commandId,
        {
          videoInput: context.videoInput,
          audioInput: context.audioInput,
          output: context.output,
          parallel: true,
        },
        context
      )
    ).resolves.toEqual(['fulfilled', 'rejected'])
    expect(ffmpeg.mergeStreams).toHaveBeenCalledTimes(1)
  })

  it('drains a cancelled probe and rejects late capability calls', async () => {
    const ffmpeg = fake()
    let finishProbe: (() => void) | undefined
    ffmpeg.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = () =>
            resolve({ streams: [{ type: 'video' }], durationMs: 1000 })
        })
    )
    const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
    let settled = false
    const result = guest
      .callMediaMerge(
        commandId,
        {
          videoInput: context.videoInput,
          audioInput: context.audioInput,
          output: context.output,
        },
        context
      )
      .catch((error: unknown) => {
        settled = true
        return error
      })
    await vi.waitFor(() => expect(ffmpeg.probe).toHaveBeenCalled())
    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    finishProbe?.()
    expect(await result).toMatchObject({ message: 'mediaMerge.cancelled' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(ffmpeg.mergeStreams).not.toHaveBeenCalled()
    expect(guest.operationState().ffmpegOperations).toBe(0)
  })

  it.each(['input', 'output', 'probe', 'transcode'])(
    'rejects an unauthorized %s before spawning',
    async (kind) => {
      const ffmpeg = fake()
      const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
      const args: Record<string, unknown> = {
        videoInput: context.videoInput,
        audioInput: context.audioInput,
        output: context.output,
      }
      if (kind === 'input') args.videoInput = '/unselected.mp4'
      if (kind === 'output') args.output = '/unselected-output.mp4'
      if (kind === 'probe') args.probe = '/unselected.mp4'
      if (kind === 'transcode') args.transcode = true
      await expect(
        guest.callMediaMerge(commandId, args, context)
      ).rejects.toThrow()
      expect(ffmpeg.mergeStreams).not.toHaveBeenCalled()
    }
  )

  it('aborts and drains the process before releasing a cancelled invocation', async () => {
    const ffmpeg = fake()
    const aborted = vi.fn()
    let rejectResult: (error: Error) => void = () => {}
    ffmpeg.mergeStreams.mockImplementation(() => ({
      id: 'pending',
      result: new Promise((_resolve, reject) => {
        rejectResult = reject
      }),
      abort: () => {
        aborted()
        rejectResult(new Error('cancelled'))
      },
      progress: { async *[Symbol.asyncIterator]() {} },
    }))
    const guest = await start(ffmpeg as unknown as FfmpegCapabilityHost)
    const result = guest.callMediaMerge(
      commandId,
      {
        videoInput: context.videoInput,
        audioInput: context.audioInput,
        output: context.output,
      },
      context
    )
    const rejected = expect(result).rejects.toThrow('mediaMerge.cancelled')
    await vi.waitFor(() => expect(ffmpeg.mergeStreams).toHaveBeenCalled())
    controller.abort()
    await rejected
    expect(aborted).toHaveBeenCalled()
    expect(guest.operationState().ffmpegOperations).toBe(0)
  })

  it.skipIf(!process.env.MOTRIX_TEST_FFMPEG)(
    'combines real video and audio tracks with FFmpeg',
    async () => {
      const binaryPath = process.env.MOTRIX_TEST_FFMPEG as string
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=32x32:r=5',
        '-t',
        '1',
        '-an',
        '-c:v',
        'libx264',
        context.videoInput,
      ])
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '1',
        '-c:a',
        'aac',
        context.audioInput,
      ])
      const originalVideo = await readFile(context.videoInput)
      const originalAudio = await readFile(context.audioInput)
      const ffmpeg = new FfmpegCapabilityHost({
        detect: { available: true, binaryPath },
      })
      const guest = await start(ffmpeg)
      await guest.callMediaMerge(
        commandId,
        {
          videoInput: context.videoInput,
          audioInput: context.audioInput,
          output: context.output,
        },
        context
      )
      const info = await ffmpeg.probe({ path: context.output })
      expect(info.streams.map((stream) => stream.type)).toEqual([
        'video',
        'audio',
      ])
      expect(info.streams.map((stream) => stream.codec)).toEqual([
        'h264',
        'aac',
      ])
      expect(await readFile(context.videoInput)).toEqual(originalVideo)
      expect(await readFile(context.audioInput)).toEqual(originalAudio)
    }
  )
})

it.skipIf(
  !process.env.MOTRIX_TEST_FFMPEG || !process.env.MOTRIX_TEST_MEDIA_MERGE_PLUGIN
)(
  'runs the packaged media merge plugin with real reversed inputs',
  async () => {
    const fixtureDir = process.env.MOTRIX_TEST_MEDIA_MERGE_PLUGIN as string
    const manifest = JSON.parse(
      await readFile(path.join(fixtureDir, 'motrix-plugin.json'), 'utf8')
    )
    const binaryPath = process.env.MOTRIX_TEST_FFMPEG as string
    const directory = await mkdtemp(path.join(tmpdir(), 'merge-package-'))
    let bridge: CapabilityBridge | undefined
    try {
      const video = path.join(directory, 'video.mp4')
      const audio = path.join(directory, 'audio.mp4')
      const output = path.join(directory, 'output.mkv')
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=32x32:r=5',
        '-t',
        '1',
        '-an',
        '-c:v',
        'libx264',
        video,
      ])
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:a',
        'aac',
        audio,
      ])
      const host = makeStubCapabilityHost()
      host.ffmpeg = new FfmpegCapabilityHost({
        detect: { available: true, binaryPath },
      })
      const spawned = await spawnTestBridge(fixtureDir, {
        capabilityHost: host,
      })
      bridge = spawned.bridge
      expect(spawned.errorCode).toBeUndefined()
      const args = { videoInput: audio, audioInput: video, output }
      await writeFile(output, 'existing output')
      await expect(
        bridge.callPlugin(`${manifest.id}.mergeStreams`, args)
      ).rejects.toMatchObject({ code: 'plugin.command.access_denied' })
      expect(await readFile(output, 'utf8')).toBe('existing output')
      await rm(output)
      await expect(
        bridge.callMediaMerge(`${manifest.id}.mergeStreams`, args, {
          ...args,
          signal: new AbortController().signal,
          onProgress: () => {},
        })
      ).resolves.toEqual({ outputPath: output })
      expect(
        (await host.ffmpeg.probe({ path: output })).streams.map(
          (stream) => stream.type
        )
      ).toEqual(['video', 'audio'])
    } finally {
      await bridge?.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
