import { EventEmitter } from 'events'
import { Menu } from 'electron'

import {
  translateTemplate,
  flattenMenuItems,
  updateStates
} from '../utils/menu'
import keymap from '@shared/keymap'
import { getI18n } from '@/ui/Locale'

export default class MenuManager extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    this.i18n = getI18n()

    this.keymap = keymap
    this.items = {}

    this.load()

    this.setup()
  }

  load () {
    const template = require(`../menus/${process.platform}.json`)
    this.template = template.menu
  }

  build () {
    const keystrokesByCommand = {}
    for (const item in this.keymap) {
      keystrokesByCommand[this.keymap[item]] = item
    }

    // Deepclone the menu template to refresh menu
    const template = JSON.parse(JSON.stringify(this.template))
    const tpl = translateTemplate(template, keystrokesByCommand, this.i18n)
    const menu = Menu.buildFromTemplate(tpl)
    return menu
  }

  setup () {
    const menu = this.build()
    Menu.setApplicationMenu(menu)
    this.items = flattenMenuItems(menu)
  }

  rebuild () {
    this.setup()
  }

  updateMenuStates (visibleStates, enabledStates, checkedStates) {
    updateStates(this.items, visibleStates, enabledStates, checkedStates)
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
}
