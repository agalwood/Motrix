import { EventEmitter } from 'events'
import { nativeTheme, systemPreferences } from 'electron'
import is from 'electron-is'

import { APP_THEME } from '@shared/constants'
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
      console.log('nativeTheme updated===>', theme)
      this.emit('system-theme-change', theme)
    })
  }

  /**
   * deprecated
   * @see https://www.electronjs.org/docs/all#systempreferencessetapplevelappearanceappearance-macos-deprecated
   */
  updateAppAppearance (theme) {
    if (!is.macOS() || theme !== APP_THEME.LIGHT || theme !== APP_THEME.DARK) {
      return
    }
    systemPreferences.setAppLevelAppearance(theme)
  }
}
