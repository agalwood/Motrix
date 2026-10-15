const YOUTUBE_URL_PATTERNS = [
  /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?v=[\w-]+|shorts\/[\w-]+|playlist\?list=[\w-]+)/,
  /^https:\/\/youtu\.be\/[\w-]+/,
]

export function probeYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL_PATTERNS.some((re) => re.test(url))
}

export function extractVideoId(url: string): string | null {
  const m1 = url.match(/[?&]v=([\w-]{11})/)
  if (m1) return m1[1] ?? null
  const m2 = url.match(/\/shorts\/([\w-]{11})/)
  if (m2) return m2[1] ?? null
  const m3 = url.match(/youtu\.be\/([\w-]{11})/)
  if (m3) return m3[1] ?? null
  return null
}
