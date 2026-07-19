import http from 'http'
import fetch from 'node-fetch'
import WebSocket from 'ws'
import logger from './Logger'
import { ADD_TASK_TYPE } from '@shared/constants'

export default class RpcProxy {
  constructor (options = {}) {
    this.port = options.port
    this.realPort = Number(this.port) + 2
    this.server = null
    this.wss = null
  }

  start () {
    this.server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', async () => {
        try {
          if (body) {
            const parsed = JSON.parse(body)
            const reqs = Array.isArray(parsed) ? parsed : [parsed]
            let intercepted = false
            for (const r of reqs) {
              if (r.method === 'aria2.addUri') {
                intercepted = true
                const params = r.params || []
                const urisIndex = Array.isArray(params[0]) ? 0 : (Array.isArray(params[1]) ? 1 : -1)
                if (urisIndex !== -1) {
                  const uris = params[urisIndex]
                  const options = params[urisIndex + 1] || {}

                  if (uris && uris.length > 0) {
                    const uri = uris[0]

                    const taskOptions = {}
                    if (options.out) taskOptions.out = options.out

                    if (options.header) {
                      const headers = Array.isArray(options.header) ? options.header : [options.header]
                      headers.forEach(h => {
                        if (h.toLowerCase().startsWith('referer:')) {
                          taskOptions.referer = h.substring(8).trim()
                        }
                        if (h.toLowerCase().startsWith('user-agent:')) {
                          taskOptions.userAgent = h.substring(11).trim()
                        }
                      })
                    }

                    logger.info('[RpcProxy] Intercepted aria2.addUri, triggering Motrix UI for', uri)
                    global.application.sendCommandToAll('application:new-task', {
                      type: ADD_TASK_TYPE.URI,
                      uri: uri,
                      ...taskOptions
                    })
                    global.application.show()
                  }
                }
              }
            }
            if (intercepted) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              const response = Array.isArray(parsed)
                ? parsed.map(r => ({ id: r.id, jsonrpc: '2.0', result: '0000000000000000' }))
                : { id: parsed.id, jsonrpc: '2.0', result: '0000000000000000' }
              res.end(JSON.stringify(response))
              return
            }
          }

          const proxyRes = await fetch(`http://127.0.0.1:${this.realPort}${req.url}`, {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
            body: body || undefined
          })
          const proxyText = await proxyRes.text()
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' })
          res.end(proxyText)
        } catch (err) {
          logger.warn('[RpcProxy] error proxying:', err.message)
          res.writeHead(500)
          res.end('Internal Server Error')
        }
      })
    })

    const wss = new WebSocket.Server({ noServer: true })

    this.server.on('upgrade', (req, socket, head) => {
      const targetWs = new WebSocket(`ws://127.0.0.1:${this.realPort}${req.url}`)

      targetWs.on('open', () => {
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          clientWs.on('message', (data) => {
            try {
              const parsed = JSON.parse(data.toString())
              if (parsed.method === 'aria2.addUri') {
                const params = parsed.params || []
                const uris = Array.isArray(params[0]) ? params[0] : (Array.isArray(params[1]) ? params[1] : null)
                if (uris && uris.length > 0) {
                  logger.info('[RpcProxy] Intercepted WS aria2.addUri for', uris[0])
                  global.application.sendCommandToAll('application:new-task', {
                    type: ADD_TASK_TYPE.URI,
                    uri: uris[0]
                  })
                  global.application.show()

                  clientWs.send(JSON.stringify({ id: parsed.id, jsonrpc: '2.0', result: '0000000000000000' }))
                  return
                }
              }
            } catch (e) {
              // ignore parse error
            }
            if (targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(data)
            }
          })

          targetWs.on('message', (data) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data)
            }
          })

          clientWs.on('close', () => targetWs.close())
          targetWs.on('close', () => clientWs.close())
        })
      })
    })

    this.server.listen(this.port, '127.0.0.1', () => {
      logger.info(`[Motrix] RpcProxy listening on ${this.port}, proxying to ${this.realPort}`)
    })
  }

  stop () {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}
