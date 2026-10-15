import { createHash } from 'node:crypto'
import {
  DownloadSubmitParamsSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
} from '@motrix/mdxp/node'
import { WebSocketServer } from 'ws'

/** Test-only MDXP peer. No MBP1 authentication, source fetch, or real tasks. */
export function createMdxpSimulator(server) {
  const wss = new WebSocketServer({ server, path: '/mdxp' })
  // The HTTP owner's listen promise reports startup failures to the runner.
  wss.on('error', () => {})
  const scenarios = new Map()
  const timers = new Set()
  wss.on('connection', (socket, request) => {
    const name = new URL(request.url, 'http://localhost').searchParams.get(
      'case'
    )
    const state = scenarios.get(name) ?? { submissions: [], tasks: new Map() }
    scenarios.set(name, state)
    let identity
    const send = (value) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value))
    }
    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON' },
        })
        return
      }
      const { id, method, params } = message
      if (id === undefined) return
      const reply = (result) => send({ jsonrpc: '2.0', id, result })
      const reject = (code, message) =>
        send({ jsonrpc: '2.0', id, error: { code, message } })
      if (message.jsonrpc !== '2.0') return reject(-32600, 'Invalid request')
      if (method === 'motrix/initialize') {
        const parsed = InitializeParamsSchema.safeParse(params)
        if (!parsed.success || parsed.data.client.kind !== 'extension')
          return reject(-32602, 'Invalid extension initialization')
        const client = parsed.data.client
        identity = `${client.browser}:${client.extensionId}`
        return reply(
          InitializeResultSchema.parse({
            protocolVersion: '1.0',
            server: {
              name: 'motrix-mdxp-simulator',
              version: '1.0',
              runtime: 'server',
            },
            capabilities: {
              ffmpegAvailable: false,
              selectionKinds: ['direct'],
              progress: false,
              cancellation: false,
            },
            serverAdapters: [],
          })
        )
      }
      if (!identity) return reject(-32600, 'Initialize first')
      if (method !== 'download/submit')
        return reject(-32601, 'Method not found')
      const parsed = DownloadSubmitParamsSchema.safeParse(params)
      if (!parsed.success || !parsed.data.idempotencyKey)
        return reject(-32602, 'Invalid keyed submission')
      const input = parsed.data
      const key = JSON.stringify([identity, input.idempotencyKey])
      const digest = createHash('sha256')
        .update(JSON.stringify(input))
        .digest('hex')
      state.submissions.push({ operationId: input.idempotencyKey })
      if (name === 'early-failed')
        return reject(-32602, 'Injected pre-dispatch rejection')
      if (name === 'early-disconnect-before') return socket.terminate()
      let task = state.tasks.get(key)
      if (task && task.digest !== digest)
        return reject(-32602, 'Operation payload changed')
      if (!task) {
        task = { taskId: `sim-${state.tasks.size + 1}`, digest }
        state.tasks.set(key, task)
        if (name === 'early-unknown') return socket.terminate()
      }
      if (name === 'early-invalid-result') return reply({ taskId: null })
      if (name === 'early-delayed') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          reply({ taskId: task.taskId })
        }, 200)
        timers.add(timer)
        return
      }
      reply({ taskId: task.taskId })
    })
  })
  return {
    snapshot(name) {
      const state = scenarios.get(name)
      return {
        submissions: state?.submissions ?? [],
        taskCount: state?.tasks.size ?? 0,
      }
    },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}
