'use strict'

import { JSONRPCClient } from './JSONRPCClient'

export class Aria2 extends JSONRPCClient {
  prefix (str) {
    if (!str.startsWith('system.') && !str.startsWith('aria2.')) {
      str = 'aria2.' + str
    }
    return str
  }

  unprefix (str) {
    const suffix = str.split('aria2.')[1]
    return suffix || str
  }

  addSecret (parameters) {
    let params = this.secret ? ['token:' + this.secret] : []
    if (Array.isArray(parameters)) {
      params = params.concat(parameters)
    }
    return params
  }

  _onnotification (notification) {
    const { method, params } = notification
    const event = this.unprefix(method)
    if (event !== method) this.emit(event, params)
    return super._onnotification(notification)
  }

  async call (method, ...params) {
    return super.call(this.prefix(method), this.addSecret(params))
  }

  async multicall (calls) {
    const multi = [
      calls.map(([method, ...params]) => {
        return { methodName: this.prefix(method), params: this.addSecret(params) }
      })
    ]
    return super.call('system.multicall', multi)
  }

  async batch (calls) {
    return super.batch(
      calls.map(([method, ...params]) => [
        this.prefix(method),
        this.addSecret(params)
      ])
    )
  }

  async listNotifications () {
    const events = await this.call('system.listNotifications')
    return events.map((event) => this.unprefix(event))
  }

  async listMethods () {
    const methods = await this.call('system.listMethods')
    return methods.map((method) => this.unprefix(method))
  }

  defaultOptions = Object.assign({}, JSONRPCClient.defaultOptions, {
    secure: false,
    host: 'localhost',
    port: 16800,
    secret: '',
    path: '/jsonrpc'
  })
}
