import { EventEmitter } from 'events'
import { nativeTheme, systemPreferences } from 'electron'
import is from 'electron-is'
import { APP_THEME } from '@shared/constants'

export default class ThemeManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.init()
  }

  init () {
    this.handleEvents()
  }

  getSystemTheme () {
    let result = APP_THEME.LIGHT
    if (!is.macOS()) {
      return result
    }
    result = nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
    return result
  }

  handleEvents () {
    if (!is.macOS()) {
      return
    }
    nativeTheme.on('updated', () => {
      const theme = this.getSystemTheme()
      console.log('theme updated===>', theme)
      this.updateAppAppearance(theme)
      this.emit('system-theme-changed', theme)
    })
  }

  updateAppAppearance (theme) {
    if (!is.macOS() || theme !== APP_THEME.LIGHT || theme !== APP_THEME.DARK) {
      return
    }
    systemPreferences.setAppLevelAppearance(theme)
  }
}
