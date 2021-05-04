import { app } from 'electron'
import is from 'electron-is'
import { existsSync, writeFile, unlink } from 'fs'
import { resolve, join } from 'path'
import { spawn } from 'child_process'

import logger from './Logger'
import { getI18n } from '../ui/Locale'
import {
  getEngineBin,
  getEnginePidPath,
  getSessionPath,
  transformConfig
} from '../utils/index'

const { platform } = process

export default class Engine {
  // ChildProcess | null
  static instance = null

  constructor (options = {}) {
    this.options = options

    this.i18n = getI18n()
    this.systemConfig = options.systemConfig
    this.userConfig = options.userConfig
    this.basePath = this.getBasePath()
  }

  start () {
    const pidPath = getEnginePidPath()
    logger.info('[Motrix] Engie pid path:', pidPath)

    if (this.instance) {
      return
    }

    const binPath = this.getBinPath()
    const args = this.getStartArgs()
    this.instance = spawn(binPath, args)
    const pid = this.instance.pid.toString()
    this.writePidFile(pidPath, pid)

    this.instance.once('close', function () {
      try {
        unlink(pidPath, function (err) {
          if (err) {
            logger.warn(`[Motrix] Unlink engine process pid file failed: ${err}`)
          }
        })
      } catch (err) {
        logger.warn(`[Motrix] Unlink engine process pid file failed: ${err}`)
      }
    })

    if (is.dev()) {
      this.instance.stdout.on('data', function (data) {
        console.log('[Motrix] engine stdout===>', data.toString())
      })

      this.instance.stderr.on('data', function (data) {
        console.log('[Motrix] engine stderr===>', data.toString())
      })
    }
  }

  stop () {
    if (this.instance) {
      this.instance.kill()
      this.instance = null
    }
  }

  writePidFile (pidPath, pid) {
    writeFile(pidPath, pid, (err) => {
      if (err) {
        logger.error(`[Motrix] Write engine process pid failed: ${err}`)
      }
    })
  }

  getBinPath () {
    const binName = getEngineBin(platform)
    if (!binName) {
      throw new Error(this.i18n.t('app.engine-damaged-message'))
    }

    const result = join(this.basePath, `/engine/${binName}`)
    const binIsExist = existsSync(result)
    if (!binIsExist) {
      logger.error('[Motrix] engine bin is not exist:', result)
      throw new Error(this.i18n.t('app.engine-missing-message'))
    }

    return result
  }

  getBasePath () {
    let result = resolve(app.getAppPath(), '..')

    if (is.dev()) {
      result = resolve(__dirname, `../../../extra/${platform}`)
    }

    return result
  }

  getStartArgs () {
    const confPath = join(this.basePath, '/engine/aria2.conf')

    const sessionPath = this.userConfig['session-path'] || getSessionPath()
    const sessionIsExist = existsSync(sessionPath)

    let result = [`--conf-path=${confPath}`, `--save-session=${sessionPath}`]
    if (sessionIsExist) {
      result = [...result, `--input-file=${sessionPath}`]
    }

    const extraConfig = {
      ...this.systemConfig
    }
    const keepSeeding = this.userConfig['keep-seeding']
    const seedRatio = this.systemConfig['seed-ratio']
    if (keepSeeding || seedRatio === 0) {
      extraConfig['seed-ratio'] = 0
      delete extraConfig['seed-time']
    }
    console.log('extraConfig===>', extraConfig)

    const extra = transformConfig(extraConfig)
    result = [...result, ...extra]

    return result
  }

  isRunning (pid) {
    try {
      return process.kill(pid, 0)
    } catch (e) {
      return e.code === 'EPERM'
    }
  }

  restart () {
    this.stop()
    this.start()
  }
}
