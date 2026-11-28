// A resolved video's finalName is frequently derived from a page URL that has
// no file extension (e.g. a bilibili bvid "BV14vJg6ZEd4"). ffmpeg refuses to
// mux when the OUTPUT filename has no recognized extension — it prints
// "Unable to choose an output format ... use a standard extension" and exits
// 234 (EINVAL). Ensure the muxed output name carries the container extension.
//
// 'ts' is an HLS *input* container; the remuxed output is still .mp4, so it
// maps to an mp4 output extension here.
const KNOWN_MEDIA_EXT = /\.(mp4|mkv|webm|mov|m4v|ts|flv|m4a|aac|mp3|opus)$/i

export function ensureMediaExtension(
  finalName: string,
  container: 'mp4' | 'mkv' | 'ts'
): string {
  if (KNOWN_MEDIA_EXT.test(finalName)) return finalName
  const ext = container === 'mkv' ? 'mkv' : 'mp4'
  return `${finalName}.${ext}`
}

/**
 * Force an audio-extract output name onto `.mp3`. A resolved best-audio
 * stream carries its own container extension ('.m4a', '.webm' — or the
 * '.mp4' a suggested page name implies), all of which must be swapped for
 * the extension the extracted file will actually have; a name with no known
 * media extension simply gets one appended.
 */
export function ensureMp3Extension(finalName: string): string {
  const base = KNOWN_MEDIA_EXT.test(finalName)
    ? finalName.replace(KNOWN_MEDIA_EXT, '')
    : finalName
  return `${base}.mp3`
}
