import { EventEmitter } from 'events'
import { join } from 'path'
import { Tray, Menu, nativeImage } from 'electron'
import is from 'electron-is'

import { APP_THEME } from '@shared/constants'
import { getInverseTheme } from '@shared/utils'
import { getI18n } from './Locale'
import {
  translateTemplate,
  flattenMenuItems,
  updateStates
} from '../utils/menu'
import { convertArrayBufferToBuffer } from '../utils/index'
// import logger from '../core/Logger'

let tray = null
const { platform } = process

export default class TrayManager extends EventEmitter {
  constructor (options = {}) {
    super()

    this.options = options
    this.theme = options.theme || APP_THEME.AUTO

    this.systemTheme = options.systemTheme
    this.inverseSystemTheme = getInverseTheme(this.systemTheme)

    this.speedometer = options.speedometer

    this.i18n = getI18n()
    this.menu = null
    this.cache = {}

    this.uploadSpeed = 0
    this.downloadSpeed = 0
    this.status = false
    this.focused = false

    this.init()
  }

  init () {
    this.loadTemplate()

    this.loadImages()

    this.initTray()

    this.setupMenu()

    this.handleEvents()
  }

  loadTemplate () {
    this.template = require('../menus/tray.json')
  }

  loadImages () {
    switch (platform) {
    case 'darwin':
      this.loadImagesForMacOS()
      break
    case 'win32':
      this.loadImagesForWindows()
      break
    case 'linux':
      this.loadImagesForLinux()
      break

    default:
      this.loadImagesForDefault()
      break
    }
  }

  loadImagesForMacOS () {
    const { systemTheme, inverseSystemTheme } = this

    this.normalIcon = this.getFromCacheOrCreateImage(`mo-tray-${systemTheme}-normal.png`)
    this.activeIcon = this.getFromCacheOrCreateImage(`mo-tray-${systemTheme}-active.png`)

    // if (systemTheme === APP_THEME.DARK) {
    //   this.inverseNormalIcon = this.normalIcon
    //   this.inverseActiveIcon = this.activeIcon
    // } else {
    this.inverseNormalIcon = this.getFromCacheOrCreateImage(`mo-tray-${inverseSystemTheme}-normal.png`)
    this.inverseActiveIcon = this.getFromCacheOrCreateImage(`mo-tray-${inverseSystemTheme}-active.png`)
    // }
  }

  loadImagesForWindows () {
    this.normalIcon = this.getFromCacheOrCreateImage('mo-tray-colorful-normal.png')
    this.activeIcon = this.getFromCacheOrCreateImage('mo-tray-colorful-active.png')
  }

  loadImagesForLinux () {
    const { theme } = this
    if (theme === APP_THEME.AUTO) {
      this.normalIcon = this.getFromCacheOrCreateImage('mo-tray-dark-normal.png')
      this.activeIcon = this.getFromCacheOrCreateImage('mo-tray-dark-active.png')
    } else {
      this.normalIcon = this.getFromCacheOrCreateImage(`mo-tray-${theme}-normal.png`)
      this.activeIcon = this.getFromCacheOrCreateImage(`mo-tray-${theme}-active.png`)
    }
  }

  loadImagesForDefault () {
    this.normalIcon = this.getFromCacheOrCreateImage('mo-tray-light-normal.png')
    this.activeIcon = this.getFromCacheOrCreateImage('mo-tray-light-active.png')
  }

  getFromCacheOrCreateImage (key) {
    let file = this.getCache(key)
    if (file) {
      return file
    }

    file = nativeImage.createFromPath(join(__static, `./${key}`))
    this.setCache(key, file)
    return file
  }

  getCache (key) {
    return this.cache[key]
  }

  setCache (key, value) {
    this.cache[key] = value
  }

  loadIcon (theme, scale) {
    const status = this.status ? 'active' : 'normal'
    const fileName = `mo-tray-${theme}-${status}@${scale}x.png`
    const bufferKey = `buffer-${fileName}`
    const buffer = this.getCache(bufferKey)

    if (buffer) {
      return buffer
    }

    const image = this.getFromCacheOrCreateImage(fileName)
    const result = image.toPNG()

    this.setCache(bufferKey, result)

    return result
  }

  buildMenu () {
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

  setupMenu () {
    this.buildMenu()

    this.updateContextMenu()
  }

  initTray () {
    const { icon } = this.getIcons()
    tray = new Tray(icon)
    // tray.setPressedImage(inverseIcon)

    tray.setToolTip('Motrix')
  }

  handleEvents () {
    // All OS
    tray.on('click', this.handleTrayClick)

    // macOS, Windows
    // tray.on('double-click', this.handleTrayDbClick)
    tray.on('right-click', this.handleTrayRightClick)
    tray.on('mouse-down', this.handleTrayMouseDown)
    tray.on('mouse-up', this.handleTrayMouseUp)

    // macOS only
    tray.setIgnoreDoubleClickEvents(true)
    tray.on('drop-files', this.handleTrayDropFiles)
    tray.on('drop-text', this.handleTrayDropText)
  }

  handleTrayClick = (event) => {
    global.application.toggle()
  }

  handleTrayDbClick = (event) => {
    global.application.show()
  }

  handleTrayRightClick = (event) => {
    tray.popUpContextMenu(this.menu)
  }

  handleTrayMouseDown = (event) => {
    this.focused = true
    this.emit('mouse-down', {
      focused: true,
      theme: this.inverseSystemTheme
    })
    this.renderTray()
  }

  handleTrayMouseUp = (event) => {
    this.focused = false
    this.emit('mouse-up', {
      focused: false,
      theme: this.theme
    })
    this.renderTray()
  }

  handleTrayDropFiles = (event, files) => {
    this.emit('drop-files', files)
  }

  handleTrayDropText = (event, text) => {
    this.emit('drop-text', text)
  }

  toggleSpeedometer (enabled) {
    this.speedometer = enabled
  }

  async renderTray () {
    if (this.speedometer) {
      return
    }

    const { icon } = this.getIcons()

    tray.setImage(icon)
    // tray.setPressedImage(inverseIcon)

    this.updateContextMenu()
  }

  getIcons () {
    const { focused, status, systemTheme } = this

    const icon = status ? this.activeIcon : this.normalIcon
    if (systemTheme === APP_THEME.DARK) {
      return {
        icon
      }
    }

    const inverseIcon = status ? this.inverseActiveIcon : this.inverseNormalIcon

    return {
      icon: focused ? inverseIcon : icon
      // inverseIcon: focused ? icon : inverseIcon
    }
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

  updateTrayFromDataURL (trayDataURL) {
    const tempImage = nativeImage.createFromDataURL(trayDataURL)
    const pngData = tempImage.toPNG()
    const image = nativeImage.createFromBuffer(pngData, {
      scaleFactor: 2
    })

    tray.setImage(image)
  }

  handleLocaleChange (locale) {
    this.setupMenu()
  }

  handleSpeedometerEnableChange (enabled) {
    this.toggleSpeedometer(enabled)

    this.renderTray()
  }

  handleSystemThemeChange (systemTheme = APP_THEME.LIGHT) {
    if (!is.macOS()) {
      return
    }

    this.systemTheme = systemTheme
    this.inverseSystemTheme = getInverseTheme(systemTheme)

    this.loadImages()

    this.renderTray()
  }

  handleDownloadStatusChange (status) {
    this.status = status

    this.renderTray()
  }

  async handleSpeedChange ({ uploadSpeed, downloadSpeed }) {
    if (!this.speedometer) {
      return
    }

    this.uploadSpeed = uploadSpeed
    this.downloadSpeed = downloadSpeed

    await this.renderTray()
  }

  async updateTrayByImage (ab) {
    const buffer = convertArrayBufferToBuffer(ab)
    const image = nativeImage.createFromBuffer(buffer, {
      scaleFactor: 2
    })

    tray.setImage(image)
  }

  destroy () {
    if (tray) {
      tray.removeListener('click', this.handleTrayClick)
      // tray.removeListener('double-click', this.handleTrayDbClick)
      tray.removeListener('right-click', this.handleTrayRightClick)
      tray.removeListener('mouse-down', this.handleTrayMouseDown)
      tray.removeListener('mouse-up', this.handleTrayMouseUp)

      tray.removeListener('drop-files', this.handleTrayDropFiles)
      tray.removeListener('drop-text', this.handleTrayDropText)
    }

    tray.destroy()
  }
}
