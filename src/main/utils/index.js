import { app, nativeTheme } from 'electron'
import is from 'electron-is'
import { resolve } from 'path'
import { existsSync, lstatSync } from 'fs'

import {
  APP_THEME,
  ENGINE_MAX_CONNECTION_PER_SERVER,
  IP_VERSION
} from '@shared/constants'

import logger from '../core/Logger'
import engineBinMap from '../configs/engine'

export function getLogPath () {
  return logger.transports.file.file
}

export function getDhtPath (protocol) {
  const name = protocol === IP_VERSION.V6 ? 'dht6.dat' : 'dht.dat'
  return resolve(app.getPath('userData'), `./${name}`)
}

export function getSessionPath () {
  return resolve(app.getPath('userData'), './download.session')
}

export function getUserDataPath () {
  return app.getPath('userData')
}

export function getUserDownloadsPath () {
  return app.getPath('downloads')
}

export function getEngineBin (platform) {
  const result = engineBinMap[platform] || ''
  return result
}

export function transformConfig (config) {
  const result = []
  for (const [k, v] of Object.entries(config)) {
    if (v !== '') {
      result.push(`--${k}=${v}`)
    }
  }
  return result
}

export function isRunningInDmg () {
  if (!is.macOS() || is.dev()) {
    return false
  }
  const appPath = app.getAppPath()
  const result = appPath.startsWith('/Volumes/')
  return result
}

export function moveAppToApplicationsFolder (errorMsg = '') {
  return new Promise((resolve, reject) => {
    try {
      const result = app.moveToApplicationsFolder()
      if (result) {
        resolve(result)
      } else {
        reject(new Error(errorMsg))
      }
    } catch (err) {
      reject(err)
    }
  })
}

export function splitArgv (argv) {
  const args = []
  const extra = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const kv = arg.split('=')
      const key = kv[0]
      const value = kv[1] || '1'
      extra[key] = value
      continue
    }
    args.push(arg)
  }
  return { args, extra }
}

export function parseArgvAsUrl (argv) {
  const arg = argv[1]
  if (!arg) {
    return
  }

  if (checkIsSupportedSchema(arg)) {
    return arg
  }
}

export function checkIsSupportedSchema (url = '') {
  const str = url.toLowerCase()
  if (
    str.startsWith('ftp:') ||
    str.startsWith('http:') ||
    str.startsWith('https:') ||
    str.startsWith('magnet:') ||
    str.startsWith('thunder:') ||
    str.startsWith('mo:') ||
    str.startsWith('motrix:')
  ) {
    return true
  } else {
    return false
  }
}

export function isDirectory (path) {
  return existsSync(path) && lstatSync(path).isDirectory()
}

export function parseArgvAsFile (argv) {
  let arg = argv[1]
  if (!arg || isDirectory(arg)) {
    return
  }

  if (is.linux()) {
    arg = arg.replace('file://', '')
  }
  return arg
}

export const getMaxConnectionPerServer = () => {
  return ENGINE_MAX_CONNECTION_PER_SERVER
}

export const getSystemTheme = () => {
  let result = APP_THEME.LIGHT
  result = nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
  return result
}

export const convertArrayBufferToBuffer = (arrayBuffer) => {
  const buffer = Buffer.alloc(arrayBuffer.byteLength)
  const view = new Uint8Array(arrayBuffer)
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i]
  }
  return buffer
}
