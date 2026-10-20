// @vitest-environment node
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorAdminExitCode, runOperatorAdmin } from './operator-admin'
import type { PairingTerminal } from './operator-extension-pairing'

const token = 't'.repeat(43)
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function serve(reply: (response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`)
    reply(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  return {
    MOTRIX_OPERATOR_TOKEN: token,
    PORT: String((server.address() as AddressInfo).port),
  }
}

describe('operator CLI direct HTTP transport', () => {
  it('uses a compatible direct fetch/Agent without the global dispatcher', async () => {
    const env = await serve((response) => response.end('[]'))
    const original = getGlobalDispatcher()
    const blocked = new MockAgent()
    blocked.disableNetConnect()
    setGlobalDispatcher(blocked)
    cleanup.push(async () => {
      setGlobalDispatcher(original)
      await blocked.close()
    })
    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await runOperatorAdmin(['pairing', 'pending'], {
        env,
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      })
    ).toBe(OperatorAdminExitCode.Success)
    expect(stdout).toEqual(['No pending pairing requests.'])
    expect(stderr).toEqual([])
  })

  it('bounds response-body reading after successful headers', async () => {
    const env = await serve((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('[')
    })
    const stderr: string[] = []
    const start = Date.now()
    const result = await runOperatorAdmin(['pairing', 'pending'], {
      env,
      pendingRetryWindowMs: 80,
      writeStdout: vi.fn(),
      writeStderr: (message) => stderr.push(message),
    })
    expect(result).toBe(OperatorAdminExitCode.Server)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(stderr.join('')).not.toContain(token)
  })

  it('cancels an incomplete body and closes the interactive view', async () => {
    const controller = new AbortController()
    const env = await serve((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('[')
      setTimeout(() => controller.abort(), 30)
    })
    const terminal: PairingTerminal = {
      interactive: true,
      signal: controller.signal,
      begin: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(),
      select: vi.fn(),
    }
    const stderr: string[] = []
    expect(
      await runOperatorAdmin(['extension', 'pair'], {
        env,
        terminal,
        writeStdout: vi.fn(),
        writeStderr: (message) => stderr.push(message),
      })
    ).toBe(OperatorAdminExitCode.Unavailable)
    expect(terminal.close).toHaveBeenCalledOnce()
    expect(terminal.show).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain(token)
  })
})
