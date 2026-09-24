export const sep = '/'

export function join(...parts: string[]): string {
  const segments: string[] = []
  for (const part of parts) {
    for (const segment of part.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        segments.pop()
        continue
      }
      segments.push(segment)
    }
  }
  return `/${segments.join('/')}`
}

export default { join, sep }
