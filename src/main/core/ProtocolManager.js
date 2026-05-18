import { EventEmitter } from 'node:events'
import { app } from 'electron'
import is from 'electron-is'
import { parse } from 'querystring'

import logger from './Logger'
import protocolMap from '../configs/protocol'
import { ADD_TASK_TYPE } from '@shared/constants'

// Commands that are safe to invoke via protocol URL without arguments
const SAFE_COMMANDS = new Set([
  'application:task-list',
  'application:pause-all-task',
  'application:resume-all-task',
  'application:preferences',
  'application:about'
])

// Commands that accept arguments but need validation
const ARGS_ALLOWED_COMMANDS = new Set([
  'application:new-task',
  'application:new-bt-task'
])

function sanitizeNewTaskArgs (args) {
  const sanitized = {}
  if (args.uri && typeof args.uri === 'string') {
    // Only allow http(s), ftp, magnet, thunder URIs
    const uri = args.uri.trim()
    if (/^(https?|ftp|magnet|thunder):/i.test(uri)) {
      sanitized.uri = uri
      sanitized.type = ADD_TASK_TYPE.URI
    } else {
      logger.warn('[Motrix] protocol handler rejected uri:', uri)
      return null
    }
  }
  return sanitized
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

    // Safe commands can be invoked without arguments
    if (SAFE_COMMANDS.has(command)) {
      global.application.sendCommandToAll(command, {})
      return
    }

    // Commands that accept arguments require validation
    if (!ARGS_ALLOWED_COMMANDS.has(command)) {
      logger.warn('[Motrix] protocol handler blocked command:', command)
      return
    }

    const query = search.startsWith('?') ? search.replace('?', '') : search
    const args = parse(query)

    let sanitizedArgs = null
    if (command === 'application:new-task' || command === 'application:new-bt-task') {
      sanitizedArgs = sanitizeNewTaskArgs(args)
    }

    if (!sanitizedArgs) {
      logger.warn('[Motrix] protocol handler rejected args for command:', command, args)
      return
    }

    global.application.sendCommandToAll(command, sanitizedArgs)
  }
}
