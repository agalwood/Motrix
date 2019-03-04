'use strict'

import { app } from 'electron'
import is from 'electron-is'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import forever from 'forever-monitor'
import logger from './Logger'
import {
  getEngineBin,
  getSessionPath,
  transformConfig
} from '../utils/index'

export default class Engine {
  static instance = null

  constructor (options = {}) {
    this.systemConfig = options.systemConfig
    this.userConfig = options.userConfig
  }

  getStartSh () {
    const { platform } = process
    let basePath = resolve(app.getAppPath(), '..')

    if (is.dev()) {
      basePath = resolve(__dirname, `../../../extra/${platform}`)
    }

    const binName = getEngineBin(platform)
    if (!binName) {
      throw new Error('引擎已损坏，请重新安装: (')
    }

    let binPath = join(basePath, `/engine/${binName}`)
    const binIsExist = existsSync(binPath)
    if (!binIsExist) {
      logger.error('[Motrix] engine bin is not exist===>', binPath)
      throw new Error('引擎文件缺失，请重新安装: (')
    }

    let confPath = join(basePath, '/engine/aria2.conf')

    let sessionPath = this.userConfig['session-path'] || getSessionPath()
    const sessionIsExist = existsSync(sessionPath)

    let result = [`${binPath}`, `--conf-path=${confPath}`, `--save-session=${sessionPath}`]
    if (sessionIsExist) {
      result = [...result, `--input-file=${sessionPath}`]
    }

    const extraConfig = transformConfig(this.systemConfig)
    result = [...result, ...extraConfig]

    return result
  }

  start () {
    const sh = this.getStartSh()
    logger.info('[Motrix] Engine start sh===>', sh)
    this.instance = forever.start(sh, {
      max: 10,
      parser: function (command, args) {
        return {
          command: command,
          args: args
        }
      },
      silent: !is.dev()
    })

    const { child } = this.instance
    logger.info('[Motrix] Engine pid===>', child.pid)

    this.instance.on('exit:code', function (code) {
      logger.info(`[Motrix] Engine  has exited after 3 restarts===> ${code}`)
    })

    this.instance.on('error', (err) => {
      logger.info(`[Motrix] Engine  has exited after 3 restarts===> ${err}`)
    })
  }

  stop () {
    const { pid } = this.instance.child
    try {
      logger.info('[Motrix] Engine stopping===>')
      this.instance.stop()
      logger.info('[Motrix] Engine stopped===>', pid)
    } catch (err) {
      logger.error('[Motrix] Engine stop fail===>', err.message)
      this.forceStop(pid)
    } finally {
    }
  }

  forceStop (pid) {
    try {
      if (pid) {
        process.kill(pid)
      }
    } catch (err) {
      logger.warn('[Motrix] Engine forceStop fail===>', err)
    }
  }

  restart () {
    this.stop()
    this.start()
  }
}
