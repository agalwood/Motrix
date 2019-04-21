import { EventEmitter } from 'events'
import { join } from 'path'
import { Tray, Menu, systemPreferences } from 'electron'
import is from 'electron-is'
import { translateTemplate } from '../utils/menu'
import { getI18n } from '@/ui/Locale'
import { LIGHT_THEME, DARK_THEME } from '@shared/constants'

let tray = null

export default class TrayManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.i18n = getI18n()

    this.menu = null

    this.load()
    this.init()
    this.setup()
    this.handleEvents()
  }

  load () {
    this.template = require(`../menus/tray.json`)
    const theme = systemPreferences.isDarkMode() ? DARK_THEME : LIGHT_THEME

    if (is.macOS()) {
      this.normalIcon = join(__static, `./mo-tray-${theme}-normal.png`)
      this.activeIcon = join(__static, `./mo-tray-${theme}-active.png`)
    } else {
      this.normalIcon = join(__static, './mo-tray-colorful-normal.png')
      this.activeIcon = join(__static, './mo-tray-colorful-active.png')
    }
  }

  build () {
    const keystrokesByCommand = {}
    for (let item in this.keymap) {
      keystrokesByCommand[this.keymap[item]] = item
    }

    // Deepclone the menu template to refresh menu
    const template = JSON.parse(JSON.stringify(this.template))
    const tpl = translateTemplate(template, keystrokesByCommand, this.i18n)
    this.menu = Menu.buildFromTemplate(tpl)
  }

  setup () {
    this.build()

    /**
     * Linux requires setContextMenu to be called
     * in order for the context menu to populate correctly
     */
    if (process.platform === 'linux') {
      tray.setContextMenu(this.menu)
    }
  }

  init () {
    tray = new Tray(this.normalIcon)
    tray.setToolTip('Motrix')
  }

  handleEvents () {
    tray.on('click', this.handleTrayClick)
    tray.on('double-click', this.handleTrayDbClick)
    tray.on('right-click', this.handleTrayRightClick)

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

  updateStatus (status) {
    this.status = status
    this.updateIcon()
  }

  updateIcon () {
    const icon = this.status ? this.activeIcon : this.normalIcon
    tray.setImage(icon)
  }

  changeIconTheme (theme = LIGHT_THEME) {
    if (!is.macOS()) {
      return
    }

    this.normalIcon = join(__static, `./mo-tray-${theme}-normal.png`)
    this.activeIcon = join(__static, `./mo-tray-${theme}-active.png`)

    this.updateIcon()
  }
}
