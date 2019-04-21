import { EventEmitter } from 'events'
import { systemPreferences } from 'electron'
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
    result = systemPreferences.isDarkMode() ? DARK_THEME : LIGHT_THEME
    return result
  }

  handleEvents () {
    if (!is.macOS()) {
      return
    }
    systemPreferences.subscribeNotification(
      'AppleInterfaceThemeChangedNotification',
      () => {
        const theme = this.getSystemTheme()
        systemPreferences.setAppLevelAppearance(theme)
        this.emit('system-theme-changed', theme)
      }
    )
  }
}
