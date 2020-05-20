import NatAPI from 'nat-api'

import logger from './Logger'

let client = null
let timer = null
const mappingStatus = {}

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
    this.clearCloseTimer()
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Motrix] UPnPManager port mapping: ', port)
      if (!port) {
        reject(new Error('[Motrix] port was not specified'))
        return
      }

      client.map(port, (err) => {
        if (err) {
          logger.warn(`[Motrix] UPnPManager map ${port} failed, error: `, err)
          reject(err.message)
          return
        }

        mappingStatus[port] = true
        logger.info(`[Motrix] UPnPManager port ${port} mapping succeeded`)
        resolve()
      })
    }).finally(() => {
      this.delayCloseClient()
    })
  }

  unmap (port) {
    this.clearCloseTimer()
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Motrix] UPnPManager port unmapping: ', port)
      if (!port) {
        reject(new Error('[Motrix] port was not specified'))
        return
      }

      if (!mappingStatus[port]) {
        resolve()
        return
      }

      client.unmap(port, (err) => {
        if (err) {
          logger.warn(`[Motrix] UPnPManager unmap ${port} failed, error: `, err)
          reject(err.message)
          return
        }

        logger.info(`[Motrix] UPnPManager port ${port} unmapping succeeded`)
        mappingStatus[port] = false
        resolve()
      })
    }).finally(() => {
      this.delayCloseClient()
    })
  }

  delayCloseClient () {
    timer = setTimeout(() => {
      this.closeClient()
    }, 30000)
  }

  clearCloseTimer () {
    clearTimeout(timer)
  }

  closeClient () {
    if (!client) {
      return
    }

    client.destroy()
    client = null
  }
}
