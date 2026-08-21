import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { smokeServerPackage } from '../../scripts/smoke-server-package.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
): Promise<string> {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

async function createFixture(): Promise<{
  stageRoot: string
  aria2Bin: string
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-server-smoke-test-')
  )
  temporaryRoots.push(root)
  const stageRoot = path.join(root, 'server-app')
  await writeFixtureFile(
    stageRoot,
    'package.json',
    `${JSON.stringify(
      {
        name: '@motrix/server-runtime-fixture',
        private: true,
        type: 'module',
        main: 'dist/server/index.cjs',
        dependencies: { 'better-sqlite3': '13.0.3' },
      },
      null,
      2
    )}\n`
  )
  const sourcePackage = await realpath(
    path.resolve('node_modules/better-sqlite3')
  )
  await cp(sourcePackage, path.join(stageRoot, 'node_modules/better-sqlite3'), {
    dereference: true,
    recursive: true,
  })
  await writeFixtureFile(
    stageRoot,
    'dist/core/plugin/host/quick-js-worker.cjs',
    [
      "const { parentPort } = require('node:worker_threads')",
      "parentPort.on('message', (message) => {",
      "  if (message.type === 'init') parentPort.postMessage({ type: 'ready' })",
      "  if (message.type === 'event' && message.event === 'shutdown') process.exit(0)",
      '})',
    ].join('\n')
  )
  await writeFixtureFile(
    stageRoot,
    'dist/server/index.cjs',
    [
      "const http = require('node:http')",
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      'const token = process.env.MOTRIX_OPERATOR_TOKEN',
      'fs.mkdirSync(process.env.MOTRIX_DATA_DIR, { recursive: true })',
      "fs.writeFileSync(path.join(process.env.MOTRIX_DATA_DIR, 'motrix.db'), Buffer.alloc(64, 1))",
      'const server = http.createServer((request, response) => {',
      "  response.setHeader('content-type', 'application/json')",
      "  if (request.url === '/healthz') { response.end('{\"ok\":true}'); return }",
      "  const authed = request.headers.authorization === 'Bearer ' + token",
      "  if (request.url === '/rpc/auth/status') { response.end(JSON.stringify({ authed })); return }",
      '  if (!authed) { response.statusCode = 401; response.end(\'{"error":"unauthorized"}\'); return }',
      '  response.statusCode = 404; response.end(\'{"error":"unknown channel"}\')',
      '})',
      "server.listen(Number(process.env.PORT), '0.0.0.0')",
      "process.once('SIGTERM', () => server.close(() => process.exit(0)))",
    ].join('\n')
  )
  await writeFixtureFile(
    stageRoot,
    'dist/server/motrix-admin.mjs',
    "console.log('motrix-admin pairing pending')\n"
  )
  await writeFixtureFile(
    stageRoot,
    'dist/renderer-web/index.html',
    '<main>ok</main>'
  )
  await writeFixtureFile(stageRoot, 'extra/aria2.conf', '')
  await mkdir(path.join(stageRoot, 'builtin-plugins'), { recursive: true })
  const aria2Bin = await writeFixtureFile(
    stageRoot,
    'bin/aria2c',
    '#!/bin/sh\nexit 0\n'
  )
  await chmod(aria2Bin, 0o755)
  return { stageRoot, aria2Bin }
}

describe('smokeServerPackage', () => {
  it('orchestrates staged roots, SQLite, worker, HTTP auth, and SIGTERM', async () => {
    const fixture = await createFixture()
    const result = await smokeServerPackage({
      appDir: fixture.stageRoot,
      timeoutMs: 10_000,
    })

    expect(result).toEqual(
      expect.objectContaining({
        directRoots: 1,
        sqlite: true,
        quickJsWorker: true,
        health: true,
        operatorAuth: true,
        operatorCli: true,
        shutdown: 'SIGTERM',
      })
    )
    expect(result.databaseBytes).toBeGreaterThan(0)
  }, 20_000)

  it('rejects an explicit missing aria2 override before startup', async () => {
    const fixture = await createFixture()
    await expect(
      smokeServerPackage({
        appDir: fixture.stageRoot,
        aria2Bin: path.join(fixture.stageRoot, 'missing-aria2c'),
      })
    ).rejects.toThrow('aria2 binary is not a file')
  })
})
