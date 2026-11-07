import { createServer, type IncomingMessage, request } from 'node:http'
import type { Duplex } from 'node:stream'
import { prepareNasSocket, secureNasSocket } from './listener'

const CLI_ROUTES = new Map([
  ['POST /motrix/client/mdxp', '/mdxp'],
  ['POST /motrix/client/mdxp/pair/request', '/mdxp/pair/request'],
  ['POST /motrix/client/mdxp/pair/poll', '/mdxp/pair/poll'],
  ['GET /motrix/client/mdxp/events', '/mdxp/events'],
])
const EXTENSION_PREFIX = '/motrix/bridge/'

/** Stable Unix upstream for DSM TLS termination. Only the running Motrix bridge
 * can be selected; DSM cookies and vendor identity headers never cross it. */
export async function listenNasClientGateway(options: {
  socketPath: string
  groupId?: number
  currentPort: () => number | undefined
  extensionEnabled: () => boolean
}) {
  const sockets = new Set<Duplex>()
  const select = (req: IncomingMessage, upgrade = false) => {
    if (upgrade && req.method !== 'GET') return undefined
    const url = req.url ?? ''
    const hostCount = req.rawHeaders.filter(
      (_value, index) =>
        index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host'
    ).length
    if (url.length > 4096 || hostCount !== 1 || !req.headers.host)
      return undefined
    const cli = !upgrade && CLI_ROUTES.get(`${req.method} ${url}`)
    if (cli) return { path: cli, cli: true }
    if (options.extensionEnabled() && url.startsWith(EXTENSION_PREFIX))
      return { path: url, cli: false }
    return undefined
  }
  const headers = (req: IncomingMessage, cli: boolean) =>
    Object.fromEntries(
      Object.entries(req.headers).filter(
        ([key]) =>
          [
            'host',
            'origin',
            'content-type',
            'content-length',
            'accept',
            'connection',
            'upgrade',
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-protocol',
            'sec-websocket-extensions',
            'x-motrix-bridge',
          ].includes(key) ||
          (cli && key === 'authorization')
      )
    )
  const port = () => {
    const value = options.currentPort()
    return value !== undefined &&
      Number.isInteger(value) &&
      value >= 1024 &&
      value <= 65535
      ? value
      : undefined
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const route = select(req)
    const target = port()
    if (!route || target === undefined) {
      res.writeHead(route ? 503 : 404, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: target,
        path: route.path,
        method: req.method,
        headers: headers(req, route.cli),
        agent: false,
      },
      (response) => {
        const { 'set-cookie': _cookie, ...safeHeaders } = response.headers
        res.writeHead(response.statusCode ?? 502, {
          ...safeHeaders,
          'cache-control': 'no-store',
        })
        response.pipe(res)
        response.on('error', () => res.destroy())
      }
    )
    upstream.setTimeout(75_000, () => upstream.destroy())
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
      res.end()
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', (socket) => {
    if (sockets.size >= 128) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, downstream, head) => {
    const route = select(req, true)
    const target = port()
    if (!route || target === undefined) {
      downstream.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = request({
      hostname: '127.0.0.1',
      port: target,
      path: route.path,
      method: 'GET',
      headers: headers(req, false),
      agent: false,
    })
    upstream.setTimeout(10_000, () => upstream.destroy())
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      // The upstream handshake deadline ends when ownership passes to the WS.
      socket.setTimeout(0)
      if (downstream.destroyed) {
        socket.destroy()
        return
      }
      const values: string[] = []
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index].toLowerCase() !== 'set-cookie')
          values.push(
            `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`
          )
      }
      downstream.write(
        `HTTP/1.1 101 Switching Protocols\r\n${values.join('\r\n')}\r\n\r\n`
      )
      if (upstreamHead.length) downstream.write(upstreamHead)
      if (head.length) socket.write(head)
      socket.on('error', () => downstream.destroy())
      downstream.on('error', () => socket.destroy())
      socket.on('close', () => downstream.destroy())
      downstream.on('close', () => socket.destroy())
      downstream.pipe(socket).pipe(downstream)
    })
    upstream.on('response', (response) => {
      response.resume()
      downstream.end(
        `HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`
      )
    })
    upstream.on('error', () => downstream.destroy())
    downstream.on('close', () => upstream.destroy())
    upstream.end()
  })
  await prepareNasSocket(options.socketPath, options.groupId)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await secureNasSocket(options.socketPath, options.groupId)
  } catch (error) {
    server.close()
    throw error
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
