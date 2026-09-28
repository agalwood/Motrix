/** Turn a host-provided RGB accent into a quiet glass hue; neutral colors stay gray. */
export function systemAccentHue(color: unknown): number | null {
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) return null
  const r = Number.parseInt(color.slice(1, 3), 16) / 255
  const g = Number.parseInt(color.slice(3, 5), 16) / 255
  const b = Number.parseInt(color.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta < 0.06) return null
  const hue =
    max === r
      ? (g - b) / delta
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4
  return (hue * 60 + 360) % 360
}
