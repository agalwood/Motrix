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
