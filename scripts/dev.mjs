#!/usr/bin/env node
// Electron dev runner.
//
// Responsibilities:
//   1. Start Vite's dev server for the renderer at a fixed port.
//   2. Run `vite build --watch` for the main and preload configs.
//   3. Once BOTH main and preload have produced their initial bundle,
//      spawn Electron with VITE_DEV_SERVER_URL pointing at the dev
//      server so the main process routes the main window to Vite.
//   4. On subsequent main/preload rebuilds, relaunch Electron so the
//      new bundle takes effect. Renderer-side hot reloads are handled
//      by Vite's built-in HMR — no restart needed.
//
// Signals:
//   SIGINT / SIGTERM — cleanly kill Electron, exit the runner.

import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { build, createServer } from 'vite'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const RENDERER_PORT = Number(process.env.VITE_DEV_PORT ?? 15173)
const RESTART_DEBOUNCE_MS = 200
const ELECTRON_SHUTDOWN_TIMEOUT_MS = 45_000
// Keep in sync with src/main/quit/termination-signals.ts.
const DEV_SHUTDOWN_MESSAGE = 'motrix:dev-shutdown'

let electronProcess = null
let shuttingDown = false
let intentionalKill = false
let restartTimer = null
let forceKillTimer = null
let restartPending = false
let shutdownExitCode = 0

function log(...args) {
  console.log('[dev]', ...args)
}

// Pack the builtin plugins into dist/builtin-plugins before Electron starts.
// In dev, resolvePluginsDir() points builtinDir at <projectRoot>/dist/builtin-plugins,
// so this tree must exist & be current or the builtin url-resolver won't load
// (the symptom: bilibili/youtube URLs fall back to a plain HTTP download).
function buildBuiltins() {
  return new Promise((resolve, reject) => {
    log('packing builtin plugins (pnpm run build:builtin)…')
    const child = spawn('pnpm', ['run', 'build:builtin'], {
      stdio: 'inherit',
      cwd: projectRoot,
    })
    child.on('exit', (code) => {
      if (code === 0) {
        log('builtin plugins packed')
        resolve()
      } else {
        reject(new Error(`build:builtin failed (exit ${code})`))
      }
    })
    child.on('error', reject)
  })
}

function makeWatchPlugin(name, onFirst, onRebuild) {
  let first = true
  return {
    name: `dev-runner-${name}`,
    writeBundle() {
      if (first) {
        first = false
        onFirst()
      } else {
        onRebuild()
      }
    },
  }
}

async function startRenderer() {
  const server = await createServer({
    configFile: path.resolve(projectRoot, 'vite.renderer.config.ts'),
    root: projectRoot,
    server: { port: RENDERER_PORT, strictPort: true },
  })
  await server.listen()
  log(`renderer at http://localhost:${RENDERER_PORT}/`)
  return server
}

function watchBuild(configName, name, onFirst, onRebuild) {
  return build({
    configFile: path.resolve(projectRoot, configName),
    root: projectRoot,
    build: { watch: {} },
    plugins: [makeWatchPlugin(name, onFirst, onRebuild)],
  })
}

function startElectron() {
  if (electronProcess || shuttingDown) return
  electronProcess = spawn(electronBinary, ['.'], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    cwd: projectRoot,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: `http://localhost:${RENDERER_PORT}/`,
    },
  })
  electronProcess.on('exit', (code) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
    const shouldRestart = restartPending
    restartPending = false
    electronProcess = null
    if (shuttingDown) {
      process.exit(shutdownExitCode)
    }
    if (shouldRestart) {
      intentionalKill = false
      startElectron()
      return
    }
    if (!shuttingDown && !intentionalKill) {
      log(`electron exited (code=${code})`)
      shutdown(code ?? 0)
    }
    intentionalKill = false
  })
}

function stopElectron({ restart }) {
  restartPending ||= restart
  const child = electronProcess
  if (!child || intentionalKill) return

  intentionalKill = true
  forceKillTimer = setTimeout(() => {
    if (electronProcess !== child) return
    log('electron did not stop gracefully — sending SIGKILL')
    child.kill('SIGKILL')
  }, ELECTRON_SHUTDOWN_TIMEOUT_MS)

  const fallbackToSignal = () => {
    if (electronProcess === child) child.kill('SIGTERM')
  }
  if (!child.connected) {
    fallbackToSignal()
    return
  }
  try {
    child.send(DEV_SHUTDOWN_MESSAGE, (err) => {
      if (!err) return
      log('failed to request graceful electron shutdown', err)
      fallbackToSignal()
    })
  } catch (err) {
    log('failed to request graceful electron shutdown', err)
    fallbackToSignal()
  }
}

function scheduleRestart() {
  if (shuttingDown) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (!electronProcess) {
      startElectron()
      return
    }
    log('rebuilt — restarting electron')
    stopElectron({ restart: true })
  }, RESTART_DEBOUNCE_MS)
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  shutdownExitCode = exitCode
  restartPending = false
  log('shutting down')
  if (!electronProcess) {
    process.exit(exitCode)
  }
  stopElectron({ restart: false })
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

async function main() {
  await buildBuiltins()
  await startRenderer()

  const mainReady = new Promise((resolve, reject) => {
    watchBuild('vite.main.config.ts', 'main', resolve, scheduleRestart).catch(
      reject
    )
  })

  const preloadReady = new Promise((resolve, reject) => {
    watchBuild(
      'vite.preload.config.ts',
      'preload',
      resolve,
      scheduleRestart
    ).catch(reject)
  })

  await Promise.all([mainReady, preloadReady])
  log('initial build complete — launching electron')
  startElectron()
}

main().catch((err) => {
  console.error(err)
  shutdown(1)
})
