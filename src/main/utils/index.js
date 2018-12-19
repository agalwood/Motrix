import { app } from 'electron'
import { resolve } from 'path'
import logger from '../core/Logger'
import engineBinMap from '../configs/engine'

export function getLogPath () {
  return logger.transports.file.file
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
  let result = engineBinMap.hasOwnProperty(platform) ? engineBinMap[platform] : ''
  return result
}

export function transformConfig (config) {
  let result = []
  for (const [k, v] of Object.entries(config)) {
    if (v !== '') {
      result.push(`--${k}=${v}`)
    }
  }
  return result
}
