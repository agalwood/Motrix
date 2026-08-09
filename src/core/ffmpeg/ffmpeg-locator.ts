import {
  detectInOrder,
  type FfmpegDetection,
  type FfmpegDetectionInput,
  probeBinary,
} from '@core/plugin/capabilities/ffmpeg-detect'

export interface FfmpegLocation {
  available: boolean
  binaryPath: string | null
  version: string | null
}

export async function locateFfmpeg(
  input: FfmpegDetectionInput,
  probe: (p: string) => Promise<FfmpegDetection> = probeBinary
): Promise<FfmpegLocation> {
  const result = await detectInOrder(input, probe)
  if (result.active) {
    return {
      available: true,
      binaryPath: result.active.path,
      version: result.active.version,
    }
  }
  return { available: false, binaryPath: null, version: null }
}
