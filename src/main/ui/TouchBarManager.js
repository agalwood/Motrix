import { EventEmitter } from 'events'
import { join } from 'path'
import { TouchBar, nativeImage } from 'electron'
import { handleCommand } from '../utils/menu'
import logger from '../core/Logger'

const { TouchBarButton, TouchBarLabel, TouchBarSpacer, TouchBarGroup } = TouchBar

export default class TouchBarManager extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    this.bars = {}
    this.load()
  }

  load () {
    this.template = require(`../menus/touchBar.json`)
  }

  getClickFn (item) {
    let fn = () => {}
    if (item.command) {
      fn = () => {
        handleCommand(item)
      }
    }
    return fn
  }

  getIconImage (icon) {
    if (!icon) {
      return
    }
    const img = join(__static, `./icons/${icon}.png`)
    return nativeImage.createFromPath(img)
  }

  buildItem (type, options) {
    let result = null
    const { label, backgroundColor, textColor, size } = options

    switch (type) {
      case 'button':
        const icon = this.getIconImage(options.icon)
        const click = this.getClickFn(options)
        result = new TouchBarButton({
          label,
          backgroundColor,
          icon,
          click
        })
        break
      case 'label':
        result = new TouchBarLabel({
          label,
          textColor
        })
        break
      case 'spacer':
        result = new TouchBarSpacer({ size })
        break
      case 'group':
        result = new TouchBarGroup({ items: options.items })
        break
      default:
        result = null
    }

    return result
  }

  build (template) {
    const result = []

    template.forEach(tpl => {
      const { id, type, ...rest } = tpl
      let options = { ...rest }
      if (type === 'group') {
        options = { type, items: this.build(options.items) }
      }
      const item = this.buildItem(type, options)
      result.push(item)
    })
    return result
  }

  getTouchBarByPage (page) {
    let bar = this.bars[page] || null
    if (!bar) {
      try {
        const items = this.build(this.template)
        bar = new TouchBar(items)
        this.bars[page] = bar
      } catch (e) {
        logger.info('getTouchBarByPage fail', e)
      }
    }
    return bar
  }

  setup (page, window) {
    const bar = this.getTouchBarByPage(page)
    window.setTouchBar(bar)
  }
}
