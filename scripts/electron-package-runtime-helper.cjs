#!/usr/bin/env node

'use strict'

const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { Worker } = require('node:worker_threads')

const [, , mode, ...args] = process.argv

function fail(message) {
  throw new Error(message)
}

function runDatabaseSmoke(packagePath, databasePath) {
  const Database = require(packagePath)
  let database = new Database(databasePath)
  const schemaVersion = database
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get().version

  database.exec(`
    CREATE TABLE IF NOT EXISTS package_runtime_smoke (
      value TEXT PRIMARY KEY NOT NULL
    )
  `)
  database
    .prepare('INSERT OR REPLACE INTO package_runtime_smoke (value) VALUES (?)')
    .run('packaged-native-ok')
  database.close()

  database = new Database(databasePath, { readonly: true })
  const reopened = database
    .prepare('SELECT value FROM package_runtime_smoke WHERE value = ?')
    .get('packaged-native-ok')
  database.close()

  return {
    electronVersion: process.versions.electron,
    schemaVersion,
    writeCloseReopen: reopened?.value === 'packaged-native-ok',
  }
}

function runQuickJsSmoke(workerPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('packaged QuickJS worker timed out'))
    }, 15_000)

    function finish(error, result) {
      clearTimeout(timer)
      if (error) {
        void worker.terminate()
        reject(error)
        return
      }
      worker.postMessage({ type: 'event', event: 'shutdown' })
      resolve(result)
    }

    worker.on('error', (error) => finish(error))
    worker.on('message', (message) => {
      if (message.type === 'call') {
        if (message.capability !== 'crypto' || message.method !== 'hash') {
          finish(
            new Error(
              `unexpected packaged capability call ${message.capability}.${message.method}`
            )
          )
          return
        }
        const digest = [
          ...createHash(message.args[0]).update(message.args[1]).digest(),
        ]
        worker.postMessage({
          type: 'response',
          id: message.id,
          ok: true,
          result: digest,
        })
        return
      }
      if (message.type === 'ready') {
        worker.postMessage({
          type: 'event',
          event: 'executeCommand',
          id: 77,
          commandId: 'package.smoke.hash',
          args: null,
        })
        return
      }
      if (message.type === 'fatal') {
        finish(
          new Error(
            `packaged QuickJS worker fatal ${message.code}: ${message.message}`
          )
        )
        return
      }
      if (
        message.type === 'event' &&
        message.event === 'executeCommandResult'
      ) {
        if (!message.ok) {
          finish(
            new Error(
              `packaged QuickJS command failed ${message.errorCode}: ${message.errorMessage}`
            )
          )
          return
        }
        finish(undefined, {
          capability: 'crypto.hash',
          digestBytes: message.result?.length,
          digestHex: message.result?.hex,
        })
      }
    })

    worker.postMessage({
      type: 'init',
      pluginId: 'package.smoke',
      manifest: {
        manifestVersion: 1,
        id: 'package.smoke',
        name: 'Package smoke',
        version: '1.0.0',
        description: 'Packaged QuickJS runtime smoke',
        categories: ['integration'],
        engines: { motrix: '>=2.0.0' },
        main: 'dist/plugin.js',
        permissions: [],
        optionalPermissions: [],
        hostPermissions: [],
        activationEvents: ['onCommand:package.smoke.hash'],
        contributes: {
          commands: [
            {
              id: 'package.smoke.hash',
              title: 'Package smoke',
              public: false,
            },
          ],
        },
      },
      bundleSource: `
        const { commands, crypto } = globalThis.__motrix_plugin_api__;
        commands.register('package.smoke.hash', async () => {
          const bytes = await crypto.hash('sha256', 'abc');
          return {
            length: bytes.length,
            hex: Array.from(bytes)
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
          };
        });
      `,
      app: {
        version: '2.0.0',
        platform: process.platform,
        runtime: 'electron',
        locale: 'en-US',
        arch: process.arch,
      },
      i18n: {
        language: 'en-US',
        dir: 'ltr',
        currentDict: {},
        fallbackDict: {},
      },
      limits: { heapMB: 32, stackKB: 256 },
    })
  })
}

async function runTraySmoke(packagePath, trayDir, outputPath) {
  const { initWasm, Resvg } = require(packagePath)
  const wasm = readFileSync(`${trayDir}/resvg.wasm`)
  await initWasm(wasm)

  const rawIcon = readFileSync(`${trayDir}/tray.svg`, 'utf8')
  const icon = rawIcon.replace(/fill="[^"]*"/g, 'fill="black"')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="134" height="44">
    <g transform="translate(0,6) scale(1)">${icon}</g>
    <text x="132" y="20" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="18" fill="black">1 MB/s</text>
    <text x="132" y="38" text-anchor="end" font-family=".SF NS,Helvetica,sans-serif" font-size="18" fill="black">2 MB/s</text>
  </svg>`
  const fontBuffers = []
  for (const fontPath of [
    `${trayDir}/SFNS-Regular.ttf`,
    '/System/Library/Fonts/Helvetica.ttc',
  ]) {
    try {
      fontBuffers.push(readFileSync(fontPath))
    } catch {
      // The packaged font is required by the verifier; the system fallback is
      // best-effort so this helper also works on non-macOS hosts.
    }
  }
  const png = Buffer.from(
    new Resvg(svg, {
      fitTo: { mode: 'width', value: 134 },
      font: { fontBuffers, defaultFontFamily: '.SF NS' },
    })
      .render()
      .asPng()
  )
  if (png.subarray(1, 4).toString() !== 'PNG') {
    fail('packaged tray speedometer output is not a PNG')
  }
  writeFileSync(outputPath, png)
  return {
    pngBytes: png.length,
    pngSha256: createHash('sha256').update(png).digest('hex'),
    wasmBytes: wasm.length,
  }
}

async function main() {
  let result
  if (mode === 'database' && args.length === 2) {
    result = runDatabaseSmoke(args[0], args[1])
  } else if (mode === 'quickjs' && args.length === 1) {
    result = await runQuickJsSmoke(args[0])
  } else if (mode === 'tray' && args.length === 3) {
    result = await runTraySmoke(args[0], args[1], args[2])
  } else {
    fail('usage: runtime-helper.cjs <database|quickjs|tray> <mode arguments>')
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
