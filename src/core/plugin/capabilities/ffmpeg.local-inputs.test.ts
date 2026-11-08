// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FfmpegCapabilityHost } from './ffmpeg'

// Real demuxers are essential here: argv-only mocks cannot show whether an
// input opens another file before a post-probe check gets a chance to run.
describe.skipIf(!process.env.MOTRIX_TEST_FFMPEG)(
  'standalone local media inputs',
  () => {
    const binaryPath = process.env.MOTRIX_TEST_FFMPEG as string
    const host = new FfmpegCapabilityHost({
      detect: { available: true, binaryPath },
    })
    const demuxers = binaryPath
      ? execFileSync(binaryPath, ['-hide_banner', '-demuxers'], {
          encoding: 'utf8',
        })
      : ''
    let dir: string
    let video: string
    let audio: string
    let allowed: string
    let privateDir: string
    const run = (...args: string[]) =>
      execFileSync(binaryPath, ['-loglevel', 'error', ...args], {
        timeout: 15_000,
      })

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'ffmpeg-local-inputs-'))
      allowed = path.join(dir, 'allowed')
      privateDir = path.join(dir, 'private')
      await mkdir(allowed)
      await mkdir(privateDir)
      video = path.join(allowed, 'video.mp4')
      audio = path.join(allowed, 'audio.m4a')
      run(
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=32x32:r=5',
        '-t',
        '1',
        '-an',
        '-c:v',
        'libx264',
        video
      )
      run(
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:a',
        'aac',
        audio
      )
      run(
        '-i',
        video,
        '-c',
        'copy',
        '-f',
        'mpegts',
        path.join(privateDir, 'not-selected.ts')
      )
      run(
        '-i',
        video,
        '-c',
        'copy',
        '-f',
        'dash',
        path.join(privateDir, 'manifest.mpd')
      )
      const dash = await readFile(path.join(privateDir, 'manifest.mpd'), 'utf8')
      await writeFile(
        path.join(allowed, 'download.mpd'),
        dash.replace(/(<Period[^>]*>)/, '$1<BaseURL>../private/</BaseURL>')
      )
      await symlink(
        path.join(privateDir, 'not-selected.ts'),
        path.join(allowed, 'linked.ts')
      )
      for (const [name, target] of [
        ['relative', '../private/not-selected.ts'],
        ['absolute', path.join(privateDir, 'not-selected.ts')],
        ['symlink', 'linked.ts'],
      ]) {
        await writeFile(
          path.join(allowed, `${name}.m3u8`),
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n${target}\n#EXT-X-ENDLIST\n`
        )
      }
      // Valid concat input disguised as MP4; basename filtering is insufficient.
      await writeFile(
        path.join(allowed, 'disguised.mp4'),
        "ffconcat version 1.0\nfile 'linked.ts'\n"
      )
    })

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it.each([
      'relative.m3u8',
      'absolute.m3u8',
      'symlink.m3u8',
      ...(/^ D\s+dash\s/m.test(demuxers) ? ['download.mpd'] : []),
      'disguised.mp4',
    ])(
      'rejects indirect input %s during both probe and merge',
      async (name) => {
        const input = path.join(allowed, name)
        // Prove the fixture actually exposes video without the manual policy.
        expect(
          (await host.probe({ path: input })).streams.some(
            (s) => s.type === 'video'
          )
        ).toBe(true)
        expect(
          (await host.probe({ path: input, localOnly: true })).streams
        ).toEqual([])
        for (const videoRole of [true, false]) {
          const output = path.join(allowed, `${name}-${videoRole}.mkv`)
          await expect(
            host.mergeStreams({
              videoInput: videoRole ? input : video,
              audioInput: videoRole ? audio : input,
              output,
              localOnly: true,
            }).result
          ).rejects.toMatchObject({ code: 'plugin.ffmpeg.exit_nonzero' })
          expect(existsSync(output)).toBe(false)
        }
      }
    )

    it.each(['mp4', 'mkv'])(
      'still merges standalone media into %s',
      async (extension) => {
        const output = path.join(allowed, `normal.${extension}`)
        expect(
          (await host.probe({ path: video, localOnly: true })).streams[0].type
        ).toBe('video')
        expect(
          (await host.probe({ path: audio, localOnly: true })).streams[0].type
        ).toBe('audio')
        await host.mergeStreams({
          videoInput: video,
          audioInput: audio,
          output,
          localOnly: true,
        }).result
        expect(
          (await host.probe({ path: output, localOnly: true })).streams.map(
            (s) => s.type
          )
        ).toEqual(['video', 'audio'])
      }
    )
  }
)
