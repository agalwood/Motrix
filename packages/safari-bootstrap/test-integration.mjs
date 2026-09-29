import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runProbe(executable, mode, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [mode], {
      env: { ...process.env, MOTRIX_BRIDGE_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(8_000),
    })
    let output = ''
    let diagnostic = ''
    child.stdout.setEncoding('utf8').on('data', (data) => {
      output += data
    })
    child.stderr.setEncoding('utf8').on('data', (data) => {
      diagnostic += data
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0)
        return reject(new Error(`Bootstrap fixture failed: ${diagnostic}`))
      try {
        resolve(JSON.parse(output))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function testBootstrapIntegration(executable) {
  for (const scenario of [
    { name: 'running-success', status: 200 },
    { name: 'running-rate-limit', status: 429 },
    { name: 'running-unavailable', status: 503 },
    { name: 'cold-success', status: 200, cold: true },
    { name: 'cold-rate-limit', status: 429, cold: true },
    { name: 'cold-unavailable', status: 503, cold: true },
    { name: 'passive-rate-limit', status: 429, passive: true },
    { name: 'passive-offline', status: 503, passive: true, cold: true },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'motrix-safari-ffi-'))
    const counts = { discovery: 0, nonce: 0 }
    const server = createServer((request, response) => {
      let status = 404
      let body = {}
      if (request.method === 'GET' && request.url === '/discovery') {
        counts.discovery += 1
        status = scenario.cold && counts.discovery === 1 ? 503 : 200
        body = {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 'ffi-fixture',
          appVersion: '2.0.0',
        }
      } else if (request.method === 'POST' && request.url === '/nonce') {
        counts.nonce += 1
        status =
          request.headers['x-motrix-bridge'] === '1' ? scenario.status : 400
        body = { nonce: 'ffi-fixture-nonce-0123456789' }
      }
      const data = JSON.stringify(body)
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      })
      response.end(data)
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = server.address().port
      const endpoint = join(directory, 'endpoint.json')
      await writeFile(endpoint, JSON.stringify({ port }), { mode: 0o600 })
      await chmod(endpoint, 0o600)
      const result = await runProbe(
        executable,
        scenario.passive ? 'passive' : 'wake',
        directory
      )
      const passiveOffline = Boolean(scenario.passive && scenario.cold)
      assert.deepEqual(
        counts,
        {
          discovery: scenario.cold && !scenario.passive ? 2 : 1,
          nonce: passiveOffline ? 0 : 1,
        },
        scenario.name
      )
      assert.equal(
        result.launches,
        scenario.cold && !scenario.passive ? 1 : 0,
        scenario.name
      )
      assert.deepEqual(
        result.response,
        scenario.status === 200
          ? {
              action: 'requestPair',
              protocolVersion: 1,
              port,
              nonce: 'ffi-fixture-nonce-0123456789',
            }
          : { error: 'bootstrap-unavailable', protocolVersion: 1 },
        scenario.name
      )
      console.log(`Safari Swift/Rust integration passed: ${scenario.name}`)
    } finally {
      server.closeAllConnections()
      if (server.listening)
        await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }
}
