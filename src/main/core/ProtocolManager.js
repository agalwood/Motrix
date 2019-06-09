
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
    // package.json:build.protocols[].schemes[]
    if (!app.isDefaultProtocolClient('mo')) {
      app.setAsDefaultProtocolClient('mo')
    }
    if (!app.isDefaultProtocolClient('motrix')) {
      app.setAsDefaultProtocolClient('motrix')
    }
    if (!app.isDefaultProtocolClient('magnet')) {
      app.setAsDefaultProtocolClient('magnet')
    }
  }

  handle (url) {
    logger.info(`[Motrix] protocol url: ${url}`)

    if (url.toLowerCase().startsWith('magnet:')) {
      return this.handleMagnetProtocol(url)
    }

    if (url.toLowerCase().startsWith('thunder:')) {
      return this.handleThunderProtocol(url)
    }

    if (
      url.toLowerCase().startsWith('mo:') ||
      url.toLowerCase().startsWith('motrix:')
    ) {
      return this.handleMoProtocol(url)
    }
  }

  handleMagnetProtocol (url) {
    if (!url) {
      return
    }
    logger.error(`[Motrix] handleMagnetProtocol url: ${url}`)

    global.application.sendCommandToAll('application:new-task', 'uri', url)
  }

  handleThunderProtocol (url) {
    if (!url) {
      return
    }
    logger.error(`[Motrix] handleThunderProtocol url: ${url}`)

    global.application.sendCommandToAll('application:new-task', 'uri', url)
  }

  handleMoProtocol (url) {
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
    global.application.sendCommandToAll(command, ...args)
  }
}
