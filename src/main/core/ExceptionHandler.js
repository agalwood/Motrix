import { app, dialog } from 'electron'
import is from 'electron-is'
import logger from './Logger'
import {
  isRunningInDmg,
  moveAppToApplicationsFolder
} from '../utils/index'

const defaults = {
  showDialog: !is.dev()
}
export default class ExceptionHandler {
  constructor (options) {
    this.options = {
      ...defaults,
      ...options
    }

    this.setup()
  }

  setup () {
    if (is.dev()) {
      return
    }
    const { showDialog } = this.options
    process.on('uncaughtException', (err) => {
      const { message, stack } = err
      logger.error(`[Motrix] uncaughtException: ${message}`)
      logger.error(stack)
      if (message.includes('spawn') && message.includes('ENOENT') && isRunningInDmg()) {
        moveAppToApplicationsFolder()
        return
      }

      if (showDialog && app.isReady()) {
        dialog.showErrorBox('系统错误', message)
      }
    })
  }
}
