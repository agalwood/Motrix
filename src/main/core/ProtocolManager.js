
import { EventEmitter } from 'events'
import { app } from 'electron'
import logger from './Logger'
import protocolMap from '../configs/protocol'

export default class ProtocolManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options

    this.init()
  }

  init () {
    // package.json:build.mac.protocols[].schemes[]
    if (!app.isDefaultProtocolClient('mo')) {
      app.setAsDefaultProtocolClient('mo')
    }
    if (!app.isDefaultProtocolClient('motrix')) {
      app.setAsDefaultProtocolClient('motrix')
    }
  }

  handle (url) {
    logger.info(`[Motrix] protocol url: ${url}`)
    const parsed = new URL(url)
    const { host } = parsed
    logger.info('[Motrix] protocol parsed:', parsed, host)

    const command = protocolMap[host]
    if (!command) {
      return
    }

    // @TODO 没想明白怎么传参数好
    // 如果按顺序传递，那 url 的 query string 就要求有序的了
    // const query = queryString.parse(parsed.query)
    const args = []
    global.application.sendCommand(command, ...args)
  }
}
