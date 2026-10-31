import path from 'node:path'
import { Aria2SegmentClient } from '@core/download/aria2-segment-client'
import type { FfmpegDetectionResult } from '@core/plugin/capabilities/ffmpeg-detect'

/** Process-lifetime media resources shared by bridge restarts and task polling. */
export function createServerMediaRuntime(opts: {
  rpcClient: ConstructorParameters<typeof Aria2SegmentClient>[0]
  adapter: ConstructorParameters<typeof Aria2SegmentClient>[1]
  tempDir: string
  detectFfmpeg: () => Promise<FfmpegDetectionResult>
}) {
  const tmpRoot = path.join(opts.tempDir, 'motrix-media')
  const segmentAria2 = new Aria2SegmentClient(opts.rpcClient, opts.adapter)
  const resolveFfmpegBinaryPath = async (): Promise<string | null> =>
    (await opts.detectFfmpeg()).active?.path ?? null

  return {
    tmpRoot,
    segmentAria2,
    resolveFfmpegBinaryPath,
    ffmpegAvailable: async () => (await resolveFfmpegBinaryPath()) !== null,
    isSegmentTask: (task: { gid: string; dir: string }): boolean => {
      if (segmentAria2.isSegmentGid(task.gid)) return true
      if (!task.dir) return false
      // Directory ownership also covers the window before addUri returns a GID
      // and stale polling snapshots after a segment's result has been purged.
      const relative = path.relative(tmpRoot, path.resolve(task.dir))
      return (
        relative === '' ||
        (relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      )
    },
  }
}
