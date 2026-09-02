import { randomBytes } from 'node:crypto'
import type { BridgeDataDirLockRecoveryAuthority } from '@core/bridge/bridge-data-dir-lock'
import { getLogger } from '@core/logger'
import { app } from 'electron'

export interface LauncherCallbacks {
  onProtocolUrl: (url: string) => void
  onTorrentFile: (filePath: string) => void
  onShowWindow: () => void
}

export interface LauncherHandle {
  wasOpenedAtLogin: boolean
  /** OS-level process ownership proof used only for bridge crash recovery. */
  bridgeDataDirLockRecoveryAuthority: BridgeDataDirLockRecoveryAuthority | null
  flushDeferred: () => void
}

const SUPPORTED_SCHEMES = ['http:', 'https:', 'ftp:', 'magnet:', 'motrix:']

function extractUrlFromArgv(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) continue
    const lower = arg.toLowerCase()
    if (SUPPORTED_SCHEMES.some((s) => lower.startsWith(s))) {
      return arg
    }
  }
  return undefined
}

function extractFilesFromArgv(argv: string[]): string[] {
  const files: string[] = []
  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i]
    if (arg.startsWith('--')) continue
    if (process.platform === 'linux') {
      arg = arg.replace(/^file:\/\//, '')
    }
    if (arg.toLowerCase().endsWith('.torrent')) {
      files.push(arg)
    }
  }
  return files
}

export function setupLauncher(callbacks: LauncherCallbacks): LauncherHandle {
  const log = getLogger('launcher')

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    log.info('another instance is running, exiting')
    app.exit(0)
    return {
      wasOpenedAtLogin: false,
      bridgeDataDirLockRecoveryAuthority: null,
      flushDeferred: () => undefined,
    }
  }

  // One unpredictable epoch for this successful Electron single-instance
  // ownership session. A restarted process receives a different epoch, which
  // lets the bridge distinguish crash residue from its own still-live handle.
  const ownershipEpoch = randomBytes(32).toString('base64url')
  const bridgeDataDirLockRecoveryAuthority: BridgeDataDirLockRecoveryAuthority =
    Object.freeze({
      ownershipEpoch,
      assertExclusiveProcessOwnership: () => true,
    })

  // Detect login launch
  let wasOpenedAtLogin = false
  if (process.platform === 'darwin') {
    wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin
  } else if (process.argv.includes('--opened-at-login=1')) {
    wasOpenedAtLogin = true
  }
  log.info({ wasOpenedAtLogin }, 'login launch detection')

  // Deferred queue
  const pendingUrls: string[] = []
  const pendingFiles: string[] = []
  let flushed = false

  function dispatchUrl(url: string) {
    if (flushed) {
      callbacks.onProtocolUrl(url)
    } else {
      pendingUrls.push(url)
    }
  }

  function dispatchFile(filePath: string) {
    if (flushed) {
      callbacks.onTorrentFile(filePath)
    } else {
      pendingFiles.push(filePath)
    }
  }

  // Parse initial argv (Windows/Linux cold start)
  if (process.platform !== 'darwin' && process.argv.length > 1) {
    const url = extractUrlFromArgv(process.argv)
    if (url) dispatchUrl(url)

    for (const file of extractFilesFromArgv(process.argv)) {
      dispatchFile(file)
    }
  }

  // second-instance (Windows/Linux: second launch passes argv)
  app.on('second-instance', (_event, argv) => {
    log.info({ argv }, 'second instance detected')
    callbacks.onShowWindow()

    if (process.platform !== 'darwin' && argv.length > 1) {
      const url = extractUrlFromArgv(argv)
      if (url) {
        dispatchUrl(url)
        return
      }

      for (const file of extractFilesFromArgv(argv)) {
        dispatchFile(file)
      }
    }
  })

  // open-url (macOS: system fires this for registered protocol schemes)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    log.info({ url }, 'open-url event')
    dispatchUrl(url)
  })

  // open-file (macOS: system fires this for associated file types)
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    log.info({ filePath }, 'open-file event')
    dispatchFile(filePath)
  })

  return {
    wasOpenedAtLogin,
    bridgeDataDirLockRecoveryAuthority,
    flushDeferred() {
      flushed = true
      for (const url of pendingUrls) {
        callbacks.onProtocolUrl(url)
      }
      pendingUrls.length = 0

      for (const file of pendingFiles) {
        callbacks.onTorrentFile(file)
      }
      pendingFiles.length = 0

      log.info('deferred queue flushed')
    },
  }
}
