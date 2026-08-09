import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

export interface FixtureServer {
  port: number
  url: string
  lastRequestHeaders(): Record<string, string | string[] | undefined>
  close(): Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const filePath = join(__dirname, 'sample.mp4')
  const stats = await stat(filePath)
  let lastHeaders: Record<string, string | string[] | undefined> = {}

  const server: Server = createServer((req, res) => {
    lastHeaders = req.headers
    if (req.url === '/file.mp4') {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(stats.size),
        'accept-ranges': 'bytes',
      })
      createReadStream(filePath).pipe(res)
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  return {
    port,
    url: `http://127.0.0.1:${port}/file.mp4`,
    lastRequestHeaders: () => lastHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
