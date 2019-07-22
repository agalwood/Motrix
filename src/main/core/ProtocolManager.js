
import { EventEmitter } from 'events'
import { app } from 'electron'
import logger from './Logger'
import protocolMap from '../configs/protocol'

export default class ProtocolManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options

    // package.json:build.protocols[].schemes[]
    // options.protocols: { 'magnet': true, 'thunder': false }
    this.protocols = {
      mo: true,
      motrix: true,
      ...options.protocols
    }

    this.init()
  }

  init () {
    const { protocols } = this
    this.setup(protocols)
  }

  setup (protocols) {
    Object.keys(protocols).forEach((protocol) => {
      const enabled = protocols[protocol]
      if (enabled) {
        if (!app.isDefaultProtocolClient(protocol)) {
          app.setAsDefaultProtocolClient(protocol)
        }
      } else {
        app.removeAsDefaultProtocolClient(protocol)
      }
    })
  }

  handle (url) {
    logger.info(`[Motrix] protocol url: ${url}`)

    if (
      url.toLowerCase().startsWith('magnet:') ||
      url.toLowerCase().startsWith('thunder:')
    ) {
      return this.handleMagnetAndThunderProtocol(url)
    }

    if (
      url.toLowerCase().startsWith('mo:') ||
      url.toLowerCase().startsWith('motrix:')
    ) {
      return this.handleMoProtocol(url)
    }
  }

  handleMagnetAndThunderProtocol (url) {
    if (!url) {
      return
    }

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
