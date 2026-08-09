// Tiny ffmpeg version + range comparer. Phase 1A only supports
// `>=N(.N(.N)?)?` — that's what manifest schema allows.

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v)
  if (!m) return null
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

export function ffmpegSatisfies(
  version: string,
  range: string | null
): boolean {
  if (range === null) return true
  const rangeM = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range)
  if (!rangeM) return false
  const v = parseVersion(version)
  if (!v) return false
  const r: [number, number, number] = [
    Number(rangeM[1] ?? 0),
    Number(rangeM[2] ?? 0),
    Number(rangeM[3] ?? 0),
  ]
  for (let i = 0; i < 3; i++) {
    if (v[i] > r[i]) return true
    if (v[i] < r[i]) return false
  }
  return true
}
