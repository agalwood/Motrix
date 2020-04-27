import NatAPI from 'nat-api'

import logger from './Logger'

let client = null

export default class UPnPManager {
  constructor (options = {}) {
    this.options = {
      ...options
    }
  }

  init () {
    if (client) {
      return
    }

    client = new NatAPI()
  }

  map (port) {
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Motrix] UPnPManager port mapping: ', port)
      client.map(port, (err) => {
        if (err) {
          logger.warn(`[Motrix] UPnPManager map ${port} failed, error: `, err)
          reject(err.message)
          return
        }

        logger.info(`[Motrix] UPnPManager port ${port} mapping succeeded`)
        resolve()
      })
    })
  }

  unmap (port) {
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Motrix] UPnPManager port unmapping: ', port)
      client.unmap(port, (err) => {
        if (err) {
          logger.warn(`[Motrix] UPnPManager unmap ${port} failed, error: `, err)
          reject(err.message)
          return
        }

        logger.info(`[Motrix] UPnPManager port ${port} unmapping succeeded`)
        resolve()
      })
    })
  }

  destroy () {
    if (!client) {
      return
    }

    client.destroy()
    client = null
  }
}
