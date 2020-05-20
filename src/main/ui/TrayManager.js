import { EventEmitter } from 'events'
import { join } from 'path'
import { Tray, Menu, nativeTheme } from 'electron'
import is from 'electron-is'

import {
  translateTemplate,
  flattenMenuItems,
  updateStates
} from '../utils/menu'
import { getI18n } from '@/ui/Locale'
import { APP_THEME } from '@shared/constants'

let tray = null

export default class TrayManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.theme = options.theme || APP_THEME.AUTO
    this.i18n = getI18n()
    this.menu = null

    this.load()
    this.init()
    this.setup()
    this.handleEvents()
  }

  load () {
    this.template = require('../menus/tray.json')

    let theme = APP_THEME.LIGHT

    if (is.windows()) {
      theme = 'colorful'
    } else if (is.macOS()) {
      theme = nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
    } else if (is.linux()) {
      theme = (this.theme === APP_THEME.AUTO) ? APP_THEME.DARK : this.theme
    }

    this.setIcons(theme)
  }

  setIcons (theme) {
    this.normalIcon = join(__static, `./mo-tray-${theme}-normal.png`)
    this.activeIcon = join(__static, `./mo-tray-${theme}-active.png`)
  }

  build () {
    const keystrokesByCommand = {}
    for (const item in this.keymap) {
      keystrokesByCommand[this.keymap[item]] = item
    }

    // Deepclone the menu template to refresh menu
    const template = JSON.parse(JSON.stringify(this.template))
    const tpl = translateTemplate(template, keystrokesByCommand, this.i18n)
    this.menu = Menu.buildFromTemplate(tpl)
    this.items = flattenMenuItems(this.menu)
  }

  setup () {
    this.build()

    this.updateContextMenu()
  }

  init () {
    tray = new Tray(this.normalIcon)
    tray.setToolTip('Motrix')
  }

  handleEvents () {
    // All OS
    tray.on('click', this.handleTrayClick)

    // macOS, Windows
    tray.on('double-click', this.handleTrayDbClick)
    tray.on('right-click', this.handleTrayRightClick)

    // macOS only
    tray.on('drop-files', this.handleTrayDropFile)
  }

  handleTrayClick = (event) => {
    event.preventDefault()
    global.application.toggle()
  }

  handleTrayDbClick = (event) => {
    event.preventDefault()
    global.application.show()
  }

  handleTrayRightClick = (event) => {
    event.preventDefault()
    tray.popUpContextMenu(this.menu)
  }

  handleTrayDropFile = (event, files) => {
    global.application.show()
    global.application.handleFile(files[0])
  }

  updateTrayByStatus (status) {
    this.status = status
    this.updateTray()
  }

  updateTray () {
    const icon = this.status ? this.activeIcon : this.normalIcon
    tray.setImage(icon)

    this.updateContextMenu()
  }

  changeIconTheme (theme = APP_THEME.LIGHT) {
    if (!is.macOS()) {
      return
    }

    this.setIcons(theme)

    this.updateTray()
  }

  updateMenuStates (visibleStates, enabledStates, checkedStates) {
    updateStates(this.items, visibleStates, enabledStates, checkedStates)

    this.updateContextMenu()
  }

  updateMenuItemVisibleState (id, flag) {
    const visibleStates = {
      [id]: flag
    }
    this.updateMenuStates(visibleStates, null, null)
  }

  updateMenuItemEnabledState (id, flag) {
    const enabledStates = {
      [id]: flag
    }
    this.updateMenuStates(null, enabledStates, null)
  }

  updateContextMenu () {
    /**
     * Linux requires setContextMenu to be called
     * in order for the context menu to populate correctly
     */
    if (process.platform !== 'linux') {
      return
    }

    tray.setContextMenu(this.menu)
  }

  destroy () {
    if (tray) {
      tray.removeListener('click', this.handleTrayClick)
      tray.removeListener('double-click', this.handleTrayDbClick)
      tray.removeListener('right-click', this.handleTrayRightClick)
      tray.removeListener('drop-files', this.handleTrayDropFile)
    }

    tray.destroy()
  }
}
