import net from 'node:net'

// Ask the OS for a free port by listening on :0 and reading the bound
// address back. The window between close() and Electron actually
// claiming it is small but non-zero; if e2e ever hits a flake here we
// can switch to a port-range scan.
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('failed to read bound port')))
      }
    })
  })
}
