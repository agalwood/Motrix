// @vitest-environment node
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { waitForRpc } from './aria2'

describe('test engine readiness ownership', () => {
  it('does not accept a successful HTTP response containing an RPC authentication error', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'probe',
          error: { code: 1, message: 'Unauthorized' },
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    try {
      await expect(
        waitForRpc(address.port, 150, 'this-instance')
      ).rejects.toThrow('did not come up')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('does not inspect a port after its own child has exited', async () => {
    await expect(
      waitForRpc(1, 5000, 'this-instance', () => new Error('child exited'))
    ).rejects.toThrow('child exited')
  })
})
