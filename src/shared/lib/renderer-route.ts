/** Only descriptive UI routes may survive a renderer generation. */
export function normalizeRendererRoute(route: string): string | undefined {
  if (route.length > 2048 || !route.startsWith('/') || route.startsWith('//'))
    return undefined
  const [pathname, query = ''] = route.split('?')
  if (
    !/^\/(?:downloads\/(?:all|active|completed|error)|settings(?:\/[a-z][a-z-]*)?|plugins(?:\/[a-z0-9][a-z0-9.-]*)?|trackers|notifications|migration)?$/.test(
      pathname
    )
  )
    return undefined
  const params = new URLSearchParams(query)
  const safe = new URLSearchParams()
  if (pathname.startsWith('/downloads/')) {
    const task = params.get('task')
    if (task && /^[a-zA-Z0-9_-]{1,128}$/.test(task)) safe.set('task', task)
  }
  return `${pathname}${safe.size ? `?${safe}` : ''}`
}
