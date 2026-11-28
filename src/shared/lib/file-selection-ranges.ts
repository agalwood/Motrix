export function formatFileSelection(
  indices: readonly number[],
  base: 0 | 1
): string {
  if (indices.length === 0) return ''
  const sorted = Array.from(new Set(indices), (index) => {
    const value = index + (1 - base)
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
      throw new RangeError('Invalid torrent file index')
    return value
  }).sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0] as number
  let previous = start
  const flush = () => {
    const length = previous - start + 1
    if (length >= 3) {
      parts.push(`${start}-${previous}`)
    } else {
      parts.push(String(start))
      if (start !== previous) parts.push(String(previous))
    }
  }
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index] as number
    if (current === previous + 1) {
      previous = current
    } else {
      flush()
      start = current
      previous = current
    }
  }
  flush()
  return parts.join(',')
}
