import { EventEmitter } from 'events'
import { nativeTheme, systemPreferences } from 'electron'
import is from 'electron-is'
import { LIGHT_THEME, DARK_THEME } from '@shared/constants'

export default class ThemeManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.init()
  }

  init () {
    this.handleEvents()
  }

  getSystemTheme () {
    let result = LIGHT_THEME
    if (!is.macOS()) {
      return result
    }
    result = nativeTheme.shouldUseDarkColors ? DARK_THEME : LIGHT_THEME
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
    if (!is.macOS() || theme !== LIGHT_THEME || theme !== DARK_THEME) {
      return
    }
    systemPreferences.setAppLevelAppearance(theme)
  }
}
