import net from 'node:net'

export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

export async function findAvailablePort(
  preferredPort: number,
  attempts = 50
): Promise<number | null> {
  const first = Math.max(1024, Math.min(preferredPort, 65_535))
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = first + offset
    if (candidate > 65_535) break
    if (await checkPort(candidate)) return candidate
  }
  return null
}
