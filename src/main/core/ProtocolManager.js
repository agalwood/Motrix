import { EventEmitter } from 'node:events'
import { app } from 'electron'
import is from 'electron-is'
import { parse } from 'querystring'

import logger from './Logger'
import protocolMap, { protocolArgsAllowlist } from '../configs/protocol'
import { ADD_TASK_TYPE } from '@shared/constants'

const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor']

/**
 * Sanitize the query object parsed from an untrusted `mo:`/`motrix:` URL.
 *
 * The protocol handler is reachable from any web page (a link click, a
 * meta refresh, etc.), so query parameters must be treated as attacker
 * controlled. This helper:
 *   1. drops keys that could be used for prototype pollution
 *   2. drops keys that are not on the per-command allowlist
 *   3. coerces values to plain strings (querystring.parse can return arrays)
 */
const sanitizeArgs = (host, rawArgs) => {
  const allowed = protocolArgsAllowlist[host] || []
  const safe = Object.create(null)

  for (const key of allowed) {
    if (FORBIDDEN_KEYS.includes(key)) {
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(rawArgs, key)) {
      continue
    }
    const value = rawArgs[key]
    if (typeof value === 'string') {
      safe[key] = value
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      // querystring.parse returns arrays when a key is repeated; only keep
      // the first occurrence to avoid smuggling multiple values.
      safe[key] = value[0]
    }
  }

  return safe
}

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

  setup (protocols = {}) {
    if (is.dev() || is.mas()) {
      return
    }

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
      url.toLowerCase().startsWith('ftp:') ||
      url.toLowerCase().startsWith('http:') ||
      url.toLowerCase().startsWith('https:') ||
      url.toLowerCase().startsWith('magnet:') ||
      url.toLowerCase().startsWith('thunder:')
    ) {
      return this.handleResourceProtocol(url)
    }

    if (
      url.toLowerCase().startsWith('mo:') ||
      url.toLowerCase().startsWith('motrix:')
    ) {
      return this.handleMoProtocol(url)
    }
  }

  handleResourceProtocol (url) {
    if (!url) {
      return
    }

    global.application.sendCommandToAll('application:new-task', {
      type: ADD_TASK_TYPE.URI,
      uri: url
    })
  }

  handleMoProtocol (url) {
    const parsed = new URL(url)
    const { host, search } = parsed
    logger.info('[Motrix] protocol parsed:', parsed, host)

    const command = protocolMap[host]
    if (!command) {
      return
    }

    const query = search.startsWith('?') ? search.replace('?', '') : search
    const rawArgs = parse(query)
    const args = sanitizeArgs(host, rawArgs)
    global.application.sendCommandToAll(command, args)
  }
}
