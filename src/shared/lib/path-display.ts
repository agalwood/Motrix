const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const isSeparator = (character: string) =>
  character === '/' || character === '\\'

/** Format local Windows paths for display/copy; never infer the server OS. */
export function formatNativePath(path: string, platform: string): string {
  if (platform !== 'win32') return path
  const windowsPath = path.replaceAll('/', '\\')
  // Keep the UNC prefix while collapsing repeated separators inside the path.
  const prefix = /^\\\\[^\\]/.test(windowsPath) ? '\\' : ''
  return prefix + windowsPath.replace(/\\+/g, '\\')
}

/** Display-only fragments; maxChars includes the single-character ellipsis. */
export function getPathDisplayParts(path: string, maxChars: number) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0)
    throw new RangeError('maxChars must be a non-negative safe integer')
  const characters = Array.from(
    segmenter.segment(path),
    ({ segment }) => segment
  )
  if (maxChars === 0) return { start: '', ellipsis: '', end: '' }
  if (characters.length <= maxChars) {
    const middle = Math.ceil(characters.length / 2)
    return {
      start: characters.slice(0, middle).join(''),
      ellipsis: '',
      end: characters.slice(middle).join(''),
    }
  }

  const available = maxChars - 1
  let startLength = Math.ceil(available / 2)
  let endLength = available - startLength
  let last = characters.length - 1
  while (last >= 0 && isSeparator(characters[last])) last--
  while (last >= 0 && !isSeparator(characters[last])) last--
  const lastSegmentLength = characters.length - last
  const rootLength = /^[a-z]:[\\/]/i.test(path)
    ? 3
    : /^(?:[\\/]{2}|~[\\/])/.test(path)
      ? 2
      : 1

  // Prefer the complete last component when the path root still fits.
  if (
    last >= 0 &&
    lastSegmentLength > endLength &&
    lastSegmentLength <= available - rootLength
  ) {
    endLength = lastSegmentLength
    startLength = available - endLength
  }
  return {
    start: characters.slice(0, startLength).join(''),
    ellipsis: '…',
    end: endLength === 0 ? '' : characters.slice(-endLength).join(''),
  }
}

/** Limit display text to maxChars graphemes, including …, without normalizing the path. */
export function truncatePath(path: string, maxChars: number): string {
  const { start, ellipsis, end } = getPathDisplayParts(path, maxChars)
  return start + ellipsis + end
}
