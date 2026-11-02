/** Hash routing leaves this directory stable for RPC, uploads and events. */
export function webBaseUrl(
  location:
    | Pick<Location, 'pathname' | 'origin'>
    | undefined = globalThis.location
): string {
  if (!location) return ''
  const pathname = location.pathname
    .replace(/\/index\.html$/, '/')
    .replace(/\/$/, '')
  return `${location.origin}${pathname}`
}
