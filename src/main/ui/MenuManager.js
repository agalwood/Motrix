import { EventEmitter } from 'events'
import { Menu } from 'electron'
import {
  translateTemplate,
  flattenMenuItems,
  updateStates
} from '../utils/menu'
import keymap from '@shared/keymap'

export default class MenuManager extends EventEmitter {
  constructor (options) {
    super()
    this.options = options

    this.keymap = keymap
    this.template = []

    this.menu = null
    this.items = {}
  }

  load (locale = 'en-US') {
    let template = null
    try {
      template = require(`../menus/${locale}/${process.platform}.json`)
      if (!template) {
        template = require(`../menus/en-US/${process.platform}.json`)
      }
    } catch (err) {
      template = require(`../menus/en-US/${process.platform}.json`)
    }
    this.template = template['menu']
  }

  build () {
    const keystrokesByCommand = {}
    for (let item in this.keymap) {
      keystrokesByCommand[this.keymap[item]] = item
    }

    const tpl = translateTemplate(this.template, keystrokesByCommand)
    this.menu = Menu.buildFromTemplate(tpl)
  }

  setup (locale) {
    this.load(locale)
    this.build()
    Menu.setApplicationMenu(this.menu)
    this.items = flattenMenuItems(this.menu)
  }

  updateStates (visibleStates, enabledStates, checkedStates) {
    updateStates(this.items, visibleStates, enabledStates, checkedStates)
  }

  updateMenuItemVisibleState (id, flag) {
    const visibleStates = {
      [id]: flag
    }
    this.updateStates(visibleStates, null, null)
  }

  updateMenuItemEnabledState (id, flag) {
    const enabledStates = {
      [id]: flag
    }
    this.updateStates(null, enabledStates, null)
  }
}
