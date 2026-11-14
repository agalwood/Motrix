import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { JsonRpcProtocol } from '@core/engine/aria2/json-rpc-protocol'
import { WebSocketTransport } from '@core/engine/aria2/web-socket-transport'
import { TaijiAdapter } from '@core/engine/taiji/taiji-adapter'
import { TaijiConfigBuilder } from '@core/engine/taiji/taiji-config-builder'
import { TaijiRpcClient } from '@core/engine/taiji/taiji-rpc-client'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'

export const bundled = path.resolve(
  'extra',
  process.platform,
  process.arch,
  process.platform === 'win32' ? 'taiji.exe' : 'taiji'
)
export const binary = process.env.MOTRIX_TAIJI_BIN ?? bundled

export async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address')
  return address.port
}

export async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    await exited
  } finally {
    clearTimeout(timeout)
  }
}

export async function start(
  directory: string,
  hold = false,
  parentPipe = false,
  listenPort = 0
) {
  const port = await freePort()
  const builder = new TaijiConfigBuilder(directory)
  await builder.prepare()
  const args = builder.buildNativeArgs(
    {
      ...DEFAULT_ENGINE_SETTINGS,
      rpcSecret: 'integration-secret',
      rpcPort: port,
      listenPort,
      dhtEnabled: false,
      btEnableLpd: false,
    },
    { download: 0, upload: 0 },
    directory
  )
  const child = spawn(binary, args, {
    cwd: directory,
    env: {
      ...process.env,
      MOTRIX_TAIJI_STARTUP_HOLD: hold ? '1' : '0',
      MOTRIX_TAIJI_PARENT_PIPE: parentPipe ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stdout?.on('data', (data) => {
    diagnostics = `${diagnostics}${data}`.slice(-8000)
  })
  child.stderr?.on('data', (data) => {
    diagnostics = `${diagnostics}${data}`.slice(-8000)
  })
  child.on('error', (error) => {
    diagnostics += error.message
  })
  const transport = new WebSocketTransport()
  const rpc = new TaijiRpcClient(
    transport,
    new JsonRpcProtocol(transport),
    'integration-secret'
  )
  const adapter = new TaijiAdapter(rpc)
  try {
    await rpc.connect(port, 50, 100)
    await adapter.connect()
  } catch (error) {
    adapter.dispose()
    rpc.disconnect()
    await stop(child)
    throw new Error(`taiji startup failed: ${diagnostics}`, { cause: error })
  }
  return {
    port,
    rpc,
    adapter,
    child,
    diagnostics: () => diagnostics,
    async close() {
      adapter.dispose()
      rpc.disconnect()
      await stop(child)
    },
  }
}
