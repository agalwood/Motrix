import { EventEmitter } from 'events'
import { nativeTheme } from 'electron'
import is from 'electron-is'

import { APP_THEME } from '@shared/constants'
import logger from '../core/Logger'
import { getSystemTheme } from '../utils'

export default class ThemeManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.options = options
    this.init()
  }

  init () {
    this.systemTheme = getSystemTheme()

    this.handleEvents()
  }

  getSystemTheme () {
    return this.systemTheme
  }

  handleEvents () {
    if (!is.macOS()) {
      return
    }

    nativeTheme.on('updated', () => {
      const theme = getSystemTheme()
      this.systemTheme = theme
      logger.info('[Motrix] nativeTheme updated===>', theme)
      this.emit('system-theme-change', theme)
    })
  }

  updateSystemTheme (theme) {
    theme = theme === APP_THEME.AUTO ? 'system' : theme
    nativeTheme.themeSource = theme
  }
}
